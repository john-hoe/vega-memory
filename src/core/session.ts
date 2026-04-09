import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";

import { isFactClaimsEnabled, isTopicRecallEnabled, type VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { isOllamaAvailable } from "../embedding/ollama.js";
import { PageManager } from "../wiki/page-manager.js";
import { ExtractionService } from "./extraction.js";
import { FactClaimService } from "./fact-claim-service.js";
import { MemoryService } from "./memory.js";
import { RecallService } from "./recall.js";
import { RegressionGuard } from "./regression-guard.js";
import { exportSnapshot } from "./snapshot.js";
import {
  estimateMemoryTokens,
  estimateTextTokens,
  estimateWikiPageTokens
} from "./token-estimate.js";
import type {
  AuditContext,
  ExtractionCandidate,
  Memory,
  MemoryType,
  SearchOptions,
  SearchResult,
  SessionStartMode,
  SessionStartResult,
  SessionStartWikiPage
} from "./types.js";

const AUTO_EXTRACT_PATTERNS: Array<{ type: MemoryType; pattern: RegExp }> = [
  { type: "decision", pattern: /决定|选择|因为|chose|decided/i },
  { type: "pitfall", pattern: /修复|解决|原因|bug|fix|solved/i },
  { type: "preference", pattern: /偏好|习惯|prefer|always use/i },
  { type: "task_state", pattern: /下一步|TODO|接下来|next step/i }
];

const now = (): string => new Date().toISOString();

const SESSION_BUDGET_RATIOS = {
  preferences: 0.1,
  activeTasks: 0.2,
  context: 0.2
} as const;
const LIGHT_SESSION_BUDGET_RATIO = 0.25;
const LIGHT_SESSION_BUDGET_RATIOS = {
  preferences: 0.3,
  activeTasks: 0.4,
  conflicts: 0.2,
  proactiveWarnings: 0.1
} as const;
const SESSION_SYNTHESIS_WARNING_PREFIX = "session-synthesis-warning:";
const SNAPSHOT_EXPORT_DEBOUNCE_MS = 60_000;
const OLLAMA_AVAILABILITY_TTL_MS = 60_000;
const EXTRACTION_MIN_SUMMARY_LENGTH = 120;
const SESSION_START_CACHE_TTL_MS = 5_000;

interface SessionWikiSearchRow {
  slug: string;
  title: string;
  summary: string;
  page_type: string;
  updated_at: string;
  rank: number;
}

interface CountRow {
  total: number;
}

const estimateTokens = (memories: Memory[]): number =>
  memories.reduce((total, memory) => total + estimateMemoryTokens(memory), 0);

const estimateWikiTokens = (pages: SessionStartWikiPage[]): number =>
  pages.reduce((total, page) => total + estimateWikiPageTokens(page), 0);

const estimateWarningTokens = (warnings: string[]): number =>
  warnings.reduce((total, warning) => total + estimateTextTokens(warning), 0);

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const parseRepoName = (originUrl: string): string | null => {
  const normalized = originUrl.trim().replace(/\/+$/, "").replace(/:/g, "/");
  const name = basename(normalized, ".git").trim();

  return name.length > 0 ? name : null;
};

const extractTaskHintKeywords = (taskHint: string): string[] =>
  [...new Set(taskHint.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
    (keyword) => keyword.length > 1
  );

const splitSentences = (summary: string): string[] =>
  (summary.match(/[^.!?。！？\n]+[.!?。！？]?/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);

const isInProjectScope = (memory: Memory, project: string): boolean =>
  memory.project === project || memory.scope === "global";

const isSessionVisible = (memory: Memory): boolean =>
  memory.status === "active" &&
  memory.verified !== "rejected" &&
  memory.verified !== "conflict";

const isRelevantMemoryType = (memory: Memory): boolean =>
  memory.type === "pitfall" || memory.type === "decision" || memory.type === "insight";

const toSessionMemory = (memory: Memory): Memory => ({
  ...memory,
  content: memory.summary ?? memory.content
});

const toRelevantResult = (memory: Memory, finalScore: number): SearchResult => ({
  memory,
  similarity: finalScore,
  finalScore
});

const dedupeRelevantResults = (results: SearchResult[]): SearchResult[] => {
  const uniqueResults = new Map<string, SearchResult>();

  for (const result of results) {
    const existing = uniqueResults.get(result.memory.id);

    if (!existing || result.finalScore > existing.finalScore) {
      uniqueResults.set(result.memory.id, result);
    }
  }

  return [...uniqueResults.values()];
};

const takeMemoriesWithinBudget = (memories: Memory[], tokenBudget: number): Memory[] => {
  if (tokenBudget <= 0) {
    return [];
  }

  const kept: Memory[] = [];
  let usedTokens = 0;

  for (const memory of memories) {
    const memoryTokens = estimateMemoryTokens(memory);

    if (memoryTokens > tokenBudget - usedTokens) {
      continue;
    }

    kept.push(memory);
    usedTokens += memoryTokens;
  }

  return kept;
};

const takeRelevantResultsWithinBudget = (
  results: SearchResult[],
  tokenBudget: number
): SearchResult[] => {
  if (tokenBudget <= 0) {
    return [];
  }

  const kept: SearchResult[] = [];
  let usedTokens = 0;

  for (const result of results) {
    const memoryTokens = estimateMemoryTokens(result.memory);

    if (memoryTokens > tokenBudget - usedTokens) {
      continue;
    }

    kept.push(result);
    usedTokens += memoryTokens;
  }

  return kept;
};

const takeWarningsWithinBudget = (warnings: string[], tokenBudget: number): string[] => {
  if (tokenBudget <= 0) {
    return [];
  }

  const kept: string[] = [];
  let usedTokens = 0;

  for (const warning of warnings) {
    const warningTokens = estimateTextTokens(warning);

    if (warningTokens > tokenBudget - usedTokens) {
      continue;
    }

    kept.push(warning);
    usedTokens += warningTokens;
  }

  return kept;
};

const countSessionResultItems = (result: SessionStartResult): number =>
  result.active_tasks.length +
  result.preferences.length +
  result.context.length +
  result.relevant.length +
  result.relevant_wiki_pages.length +
  result.recent_unverified.length +
  result.conflicts.length;

const appendWarnings = (warnings: string[], nextWarnings: string[]): string[] =>
  [...new Set([...warnings, ...nextWarnings])];

const sortByCreatedAtDesc = (memories: Memory[]): Memory[] =>
  [...memories].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));

const dedupeMemoriesById = (memories: Memory[]): Memory[] => [...new Map(
  memories.map((memory) => [memory.id, memory])
).values()];

export class SessionService {
  private readonly sessionStartTimes = new Map<string, string>();
  private readonly extractionService: ExtractionService;
  private readonly regressionGuard: RegressionGuard;
  private readonly inferredProjects = new Map<string, string>();
  private readonly snapshotExportTimes = new Map<string, number>();
  private readonly sessionStartCache = new Map<
    string,
    {
      cachedAt: number;
      project: string;
      result: SessionStartResult;
    }
  >();
  private lastOllamaAvailabilityCheck:
    | {
        checkedAt: number;
        available: boolean;
      }
    | null = null;

  constructor(
    private readonly repository: Repository,
    private readonly memoryService: MemoryService,
    private readonly recallService: RecallService,
    private readonly config: VegaConfig,
    private readonly pageManager?: PageManager | null,
    regressionGuard?: RegressionGuard,
    private readonly factClaimService = new FactClaimService(repository, config)
  ) {
    this.extractionService = new ExtractionService(config);
    this.regressionGuard = regressionGuard ?? new RegressionGuard(repository, config);
  }

  async sessionStart(
    workingDirectory: string,
    taskHint?: string,
    tenantId?: string | null,
    mode: SessionStartMode = "standard"
  ): Promise<SessionStartResult> {
    const startedAt = Date.now();
    const project = this.inferProject(workingDirectory);
    this.sessionStartTimes.set(project, now());
    const normalizedTaskHint = taskHint?.trim() ?? "";
    const taskHintKeywords = normalizedTaskHint ? extractTaskHintKeywords(normalizedTaskHint) : [];
    const cacheKey = `${resolve(workingDirectory)}\u0000${tenantId ?? ""}\u0000${normalizedTaskHint}\u0000${mode}`;
    const cached = this.sessionStartCache.get(cacheKey);

    if (cached && Date.now() - cached.cachedAt < SESSION_START_CACHE_TTL_MS) {
      const result = structuredClone(cached.result) as SessionStartResult;
      const violations = this.regressionGuard.recordSessionStart(
        mode,
        result.token_estimate,
        Date.now() - startedAt,
        {
          tenantId,
          memoryCount: this.repository.countActiveMemories(project, undefined, true, tenantId),
          resultCount: countSessionResultItems(result)
        }
      );

      result.proactive_warnings = appendWarnings(
        result.proactive_warnings,
        violations.map((violation) => this.regressionGuard.formatWarning(violation))
      );

      return result;
    }

    const result =
      mode === "light"
        ? this.buildLightSessionStartResult(project, taskHintKeywords, tenantId)
        : await this.buildStandardSessionStartResult(
            project,
            normalizedTaskHint,
            taskHintKeywords,
            tenantId
          );
    const violations = this.regressionGuard.recordSessionStart(
      mode,
      result.token_estimate,
      Date.now() - startedAt,
      {
        tenantId,
        memoryCount: this.repository.countActiveMemories(project, undefined, true, tenantId),
        resultCount: countSessionResultItems(result)
      }
    );

    result.proactive_warnings = appendWarnings(
      result.proactive_warnings,
      violations.map((violation) => this.regressionGuard.formatWarning(violation))
    );

    this.sessionStartCache.set(cacheKey, {
      cachedAt: Date.now(),
      project,
      result
    });

    return structuredClone(result) as SessionStartResult;
  }

  async sessionEnd(
    project: string,
    summary: string,
    completedTaskIds?: string[],
    auditContext?: AuditContext,
    tenantId?: string | null
  ): Promise<void> {
    const ended_at = now();
    const started_at = this.sessionStartTimes.get(project) ?? ended_at;
    const newlyCreatedMemoryIds: string[] = [];

    for (const taskId of completedTaskIds ?? []) {
      const existing = this.repository.getMemory(taskId);

      if (existing === null) {
        throw new Error(`Memory not found: ${taskId}`);
      }

      if (tenantId !== undefined && tenantId !== null && (existing.tenant_id ?? null) !== tenantId) {
        throw new Error("forbidden");
      }
    }

    for (const taskId of completedTaskIds ?? []) {
      this.repository.updateMemory(
        taskId,
        {
          importance: 0.2,
          updated_at: ended_at
        },
        { auditContext }
      );
    }

    const memories_created: string[] = [];
    const ollamaAvailable = await this.isOllamaAvailableCached();
    const extracted = ollamaAvailable
      ? await this.extractWithThreshold(summary, project)
      : [];

    if (extracted.length > 0) {
      for (const candidate of extracted) {
        const stored = await this.memoryService.store({
          content: candidate.content,
          type: candidate.type,
          project,
          title: candidate.title,
          tags: candidate.tags,
          source: "auto",
          auditContext
        });

        if (stored.id && (stored.action === "created" || stored.action === "conflict")) {
          memories_created.push(stored.id);
        }

        if (stored.id && stored.action === "created") {
          newlyCreatedMemoryIds.push(stored.id);
        }
      }
    } else {
      for (const sentence of splitSentences(summary)) {
        for (const { type, pattern } of AUTO_EXTRACT_PATTERNS) {
          if (!pattern.test(sentence)) {
            continue;
          }

          const stored = await this.memoryService.store({
            content: sentence,
            type,
            project,
            source: "auto",
            auditContext
          });

          if (stored.id && (stored.action === "created" || stored.action === "conflict")) {
            memories_created.push(stored.id);
          }

          if (stored.id && stored.action === "created") {
            newlyCreatedMemoryIds.push(stored.id);
          }
        }
      }
    }

    this.updatePendingSynthesisWarning(project, newlyCreatedMemoryIds);

    this.repository.createSession({
      id: uuidv4(),
      project,
      summary,
      started_at,
      ended_at,
      memories_created
    });

    const nowMs = Date.now();
    const lastSnapshotExportAt = this.snapshotExportTimes.get(project) ?? 0;
    if (nowMs - lastSnapshotExportAt >= SNAPSHOT_EXPORT_DEBOUNCE_MS) {
      exportSnapshot(this.repository, this.getSnapshotPath(project));
      this.snapshotExportTimes.set(project, nowMs);
    }
    for (const [key, value] of this.sessionStartCache.entries()) {
      if (value.project === project) {
        this.sessionStartCache.delete(key);
      }
    }
    this.sessionStartTimes.delete(project);
  }

  private async isOllamaAvailableCached(): Promise<boolean> {
    if (
      this.lastOllamaAvailabilityCheck !== null &&
      Date.now() - this.lastOllamaAvailabilityCheck.checkedAt < OLLAMA_AVAILABILITY_TTL_MS
    ) {
      return this.lastOllamaAvailabilityCheck.available;
    }

    const available = await isOllamaAvailable(this.config);
    this.lastOllamaAvailabilityCheck = {
      checkedAt: Date.now(),
      available
    };

    return available;
  }

  private async extractWithThreshold(summary: string, project: string): Promise<ExtractionCandidate[]> {
    if (summary.trim().length < EXTRACTION_MIN_SUMMARY_LENGTH) {
      return [];
    }

    return this.extractionService.extractMemories(summary, project);
  }

  private buildSessionRecallOptions(tenantId?: string | null): SearchOptions {
    const shouldQuerySidecars =
      isTopicRecallEnabled(this.config) || isFactClaimsEnabled(this.config);

    return {
      limit: 5,
      minSimilarity: 0.3,
      tenant_id: tenantId ?? undefined,
      ...(shouldQuerySidecars ? {} : { topic: undefined })
    };
  }

  private async buildStandardSessionStartResult(
    project: string,
    normalizedTaskHint: string,
    taskHintKeywords: string[],
    tenantId?: string | null
  ): Promise<SessionStartResult> {
    const preferences = this.filterFactClaimExpiredMemories(
      this.loadSessionPreferences(tenantId),
      tenantId
    );
    const globalRelevant = this.filterFactClaimExpiredMemories(
      [
      ...this.repository.listMemories({
        scope: "global",
        type: "pitfall",
        status: "active",
        tenant_id: tenantId ?? undefined,
        limit: 20,
        sort: "importance DESC"
      }),
      ...this.repository.listMemories({
        scope: "global",
        type: "decision",
        status: "active",
        tenant_id: tenantId ?? undefined,
        limit: 10,
        sort: "importance DESC"
      }),
      ...this.repository.listMemories({
        scope: "global",
        type: "insight",
        status: "active",
        tenant_id: tenantId ?? undefined,
        limit: 10,
        sort: "importance DESC"
      })
    ].filter(isSessionVisible),
      tenantId
    );
    const active_tasks = this.filterFactClaimExpiredMemories(
      this.loadActiveTasks(project, tenantId),
      tenantId
    );
    const context = this.filterFactClaimExpiredMemories(
      this.repository
        .listMemories({
          type: "project_context",
          status: "active",
          project,
          tenant_id: tenantId ?? undefined,
          limit: 10_000
        })
        .filter(isSessionVisible),
      tenantId
    );
    const relevantResults =
      taskHintKeywords.length > 0
        ? this.filterFactClaimExpiredResults(
            (await this.recallService.recall(
              normalizedTaskHint,
              this.buildSessionRecallOptions(tenantId)
            ))
              .map((result) => ({
                ...result,
                finalScore:
                  result.memory.project === project ? result.finalScore : result.finalScore * 0.5
              }))
              .filter(
                (result) =>
                  isRelevantMemoryType(result.memory) && result.memory.verified !== "conflict"
              ),
            tenantId
          )
        : [];
    const excludedIds = new Set([
      ...preferences.map((memory) => memory.id),
      ...active_tasks.map((memory) => memory.id),
      ...context.map((memory) => memory.id)
    ]);
    const allRelevantResults = dedupeRelevantResults([
      ...globalRelevant.map((memory) => toRelevantResult(memory, memory.importance)),
      ...relevantResults
    ]).filter((result) => !excludedIds.has(result.memory.id));
    const allMemories = this.filterFactClaimExpiredMemories(
      this.repository.listMemories({
        status: "active",
        tenant_id: tenantId ?? undefined,
        limit: 10_000,
        sort: "created_at DESC"
      }),
      tenantId
    );
    const relevant_wiki_pages = this.pageManager
      ? this.loadRelevantWikiPages(project, taskHintKeywords)
      : [];
    const wiki_drafts_pending = this.pageManager ? this.countWikiDrafts(project) : 0;
    const recent_unverified = sortByCreatedAtDesc(
      allMemories.filter(
        (memory) => memory.verified === "unverified" && isInProjectScope(memory, project)
      )
    ).slice(0, 3);
    const conflicts = sortByCreatedAtDesc(
      allMemories.filter((memory) => memory.verified === "conflict" && isInProjectScope(memory, project))
    );
    const proactive_warnings = this.loadProactiveWarnings(project, taskHintKeywords, tenantId);

    const preferenceBudget = Math.floor(this.config.tokenBudget * SESSION_BUDGET_RATIOS.preferences);
    const activeTaskBudget = Math.floor(this.config.tokenBudget * SESSION_BUDGET_RATIOS.activeTasks);
    const contextBudget = Math.floor(this.config.tokenBudget * SESSION_BUDGET_RATIOS.context);
    const trimmedPreferences = takeMemoriesWithinBudget(preferences, preferenceBudget);
    const trimmedActiveTasks = takeMemoriesWithinBudget(active_tasks, activeTaskBudget);
    const trimmedContext = takeMemoriesWithinBudget(context, contextBudget);
    const baseBudgetUsage = estimateTokens([
      ...trimmedPreferences,
      ...trimmedActiveTasks,
      ...trimmedContext
    ]);
    const trimmedRecentUnverified = takeMemoriesWithinBudget(
      recent_unverified,
      Math.max(0, this.config.tokenBudget - baseBudgetUsage)
    );
    const trimmedConflicts = takeMemoriesWithinBudget(
      conflicts,
      Math.max(
        0,
        this.config.tokenBudget -
          estimateTokens([
            ...trimmedPreferences,
            ...trimmedActiveTasks,
            ...trimmedContext,
            ...trimmedRecentUnverified
          ])
      )
    );
    const usedNonRelevantBudget = estimateTokens([
      ...trimmedPreferences,
      ...trimmedActiveTasks,
      ...trimmedContext,
      ...trimmedRecentUnverified,
      ...trimmedConflicts
    ]);
    const trimmedRelevantResults = takeRelevantResultsWithinBudget(
      [...allRelevantResults].sort((left, right) => right.finalScore - left.finalScore),
      Math.max(0, this.config.tokenBudget - usedNonRelevantBudget)
    );
    const token_estimate = estimateTokens([
      ...trimmedPreferences,
      ...trimmedActiveTasks,
      ...trimmedContext,
      ...trimmedRelevantResults.map((result) => result.memory),
      ...trimmedRecentUnverified,
      ...trimmedConflicts
    ]) + estimateWikiTokens(relevant_wiki_pages);

    return {
      project,
      active_tasks: trimmedActiveTasks.map(toSessionMemory),
      preferences: trimmedPreferences.map(toSessionMemory),
      context: trimmedContext.map(toSessionMemory),
      relevant: [...trimmedRelevantResults]
        .sort((left, right) => right.finalScore - left.finalScore)
        .map((result) => toSessionMemory(result.memory)),
      relevant_wiki_pages,
      wiki_drafts_pending,
      recent_unverified: trimmedRecentUnverified.map(toSessionMemory),
      conflicts: trimmedConflicts.map(toSessionMemory),
      proactive_warnings,
      token_estimate
    };
  }

  private buildLightSessionStartResult(
    project: string,
    taskHintKeywords: string[],
    tenantId?: string | null
  ): SessionStartResult {
    const lightTokenBudget = Math.floor(this.config.tokenBudget * LIGHT_SESSION_BUDGET_RATIO);
    const preferences = this.filterFactClaimExpiredMemories(
      this.loadSessionPreferences(tenantId),
      tenantId
    );
    const active_tasks = this.filterFactClaimExpiredMemories(
      this.loadActiveTasks(project, tenantId),
      tenantId
    );
    const conflicts = this.filterFactClaimExpiredMemories(
      sortByCreatedAtDesc(
        dedupeMemoriesById([
          ...this.repository.listMemories({
            project,
            status: "active",
            verified: "conflict",
            tenant_id: tenantId ?? undefined,
            limit: 10_000,
            sort: "created_at DESC"
          }),
          ...this.repository.listMemories({
            scope: "global",
            status: "active",
            verified: "conflict",
            tenant_id: tenantId ?? undefined,
            limit: 10_000,
            sort: "created_at DESC"
          })
        ])
      ),
      tenantId
    );
    const proactive_warnings = this.loadProactiveWarnings(project, taskHintKeywords, tenantId);

    const preferenceBudget = Math.floor(
      lightTokenBudget * LIGHT_SESSION_BUDGET_RATIOS.preferences
    );
    const activeTaskBudget = Math.floor(
      lightTokenBudget * LIGHT_SESSION_BUDGET_RATIOS.activeTasks
    );
    const conflictBudget = Math.floor(lightTokenBudget * LIGHT_SESSION_BUDGET_RATIOS.conflicts);
    const proactiveWarningBudget = Math.floor(
      lightTokenBudget * LIGHT_SESSION_BUDGET_RATIOS.proactiveWarnings
    );
    const trimmedPreferences = takeMemoriesWithinBudget(preferences, preferenceBudget);
    const trimmedActiveTasks = takeMemoriesWithinBudget(active_tasks, activeTaskBudget);
    const trimmedConflicts = takeMemoriesWithinBudget(conflicts, conflictBudget);
    const trimmedWarnings = takeWarningsWithinBudget(proactive_warnings, proactiveWarningBudget);
    const token_estimate =
      estimateTokens([...trimmedPreferences, ...trimmedActiveTasks, ...trimmedConflicts]) +
      estimateWarningTokens(trimmedWarnings);

    return {
      project,
      active_tasks: trimmedActiveTasks.map(toSessionMemory),
      preferences: trimmedPreferences.map(toSessionMemory),
      context: [],
      relevant: [],
      relevant_wiki_pages: [],
      wiki_drafts_pending: 0,
      recent_unverified: [],
      conflicts: trimmedConflicts.map(toSessionMemory),
      proactive_warnings: trimmedWarnings,
      token_estimate
    };
  }

  private loadSessionPreferences(tenantId?: string | null): Memory[] {
    return this.repository
      .listMemories({
        type: "preference",
        status: "active",
        scope: "global",
        tenant_id: tenantId ?? undefined,
        limit: 10_000,
        sort: "importance DESC"
      })
      .filter(isSessionVisible);
  }

  private loadActiveTasks(project: string, tenantId?: string | null): Memory[] {
    return this.repository
      .listMemories({
        type: "task_state",
        status: "active",
        project,
        tenant_id: tenantId ?? undefined,
        limit: 10_000
      })
      .filter(isSessionVisible);
  }

  private getFactClaimExcludedMemoryIds(
    memories: Memory[],
    tenantId?: string | null
  ): Set<string> {
    if (!isFactClaimsEnabled(this.config) || memories.length === 0) {
      return new Set<string>();
    }

    try {
      const candidateIds = new Set(memories.map((memory) => memory.id));
      const projects = [...new Set(memories.map((memory) => memory.project))];
      const hiddenMemoryIds = new Set<string>();

      for (const project of projects) {
        const claims = this.factClaimService.listClaims(
          project,
          ["active", "conflict", "expired", "suspected_expired"],
          undefined,
          tenantId
        );
        const memoryStates = new Map<
          string,
          { hasExpiredOrSuspected: boolean; hasActiveOrConflict: boolean }
        >();

        for (const claim of claims) {
          if (claim.source_memory_id === null || !candidateIds.has(claim.source_memory_id)) {
            continue;
          }

          const current = memoryStates.get(claim.source_memory_id) ?? {
            hasExpiredOrSuspected: false,
            hasActiveOrConflict: false
          };

          if (claim.status === "expired" || claim.status === "suspected_expired") {
            current.hasExpiredOrSuspected = true;
          }

          if (claim.status === "active" || claim.status === "conflict") {
            current.hasActiveOrConflict = true;
          }

          memoryStates.set(claim.source_memory_id, current);
        }

        for (const [memoryId, state] of memoryStates.entries()) {
          if (state.hasExpiredOrSuspected && !state.hasActiveOrConflict) {
            hiddenMemoryIds.add(memoryId);
          }
        }
      }

      return hiddenMemoryIds;
    } catch {
      return new Set<string>();
    }
  }

  private filterFactClaimExpiredMemories(memories: Memory[], tenantId?: string | null): Memory[] {
    const hiddenMemoryIds = this.getFactClaimExcludedMemoryIds(memories, tenantId);

    if (hiddenMemoryIds.size === 0) {
      return memories;
    }

    return memories.filter((memory) => !hiddenMemoryIds.has(memory.id));
  }

  private filterFactClaimExpiredResults(
    results: SearchResult[],
    tenantId?: string | null
  ): SearchResult[] {
    const hiddenMemoryIds = this.getFactClaimExcludedMemoryIds(
      results.map((result) => result.memory),
      tenantId
    );

    if (hiddenMemoryIds.size === 0) {
      return results;
    }

    return results.filter((result) => !hiddenMemoryIds.has(result.memory.id));
  }

  private loadFactClaimWarnings(project: string, tenantId?: string | null): string[] {
    if (!isFactClaimsEnabled(this.config)) {
      return [];
    }

    try {
      const grouped = new Map<string, { subject: string; predicate: string; values: Set<string> }>();

      for (const claim of this.factClaimService.listClaims(project, "conflict", undefined, tenantId)) {
        const key = `${claim.subject}\u0000${claim.predicate}`;
        const current = grouped.get(key) ?? {
          subject: claim.subject,
          predicate: claim.predicate,
          values: new Set<string>()
        };

        current.values.add(claim.claim_value);
        grouped.set(key, current);
      }

      return [...grouped.values()]
        .filter((entry) => entry.values.size > 0)
        .map(
          (entry) =>
            `fact claim conflict: ${entry.subject} ${entry.predicate} -> ${[...entry.values].sort().join(" | ")}`
        );
    } catch {
      return [];
    }
  }

  private loadProactiveWarnings(
    project: string,
    taskHintKeywords: string[],
    tenantId?: string | null
  ): string[] {
    return [
      ...(taskHintKeywords.length > 0
        ? this.filterFactClaimExpiredMemories(
            this.repository
              .listMemories({
                type: "insight",
                status: "active",
                tenant_id: tenantId ?? undefined,
                limit: 10_000,
                sort: "importance DESC"
              })
              .filter(
                (memory) => isInProjectScope(memory, project) && isSessionVisible(memory)
              ),
            tenantId
          )
            .filter((memory) => {
              const tags = memory.tags.map((tag) => tag.toLowerCase());
              return taskHintKeywords.some((keyword) => tags.includes(keyword));
            })
            .map((memory) => memory.content)
        : []),
      ...this.loadFactClaimWarnings(project, tenantId),
      ...this.consumePendingSynthesisWarnings(project)
    ];
  }

  inferProject(workingDirectory: string): string {
    const normalizedDirectory = resolve(workingDirectory);
    const cached = this.inferredProjects.get(normalizedDirectory);
    if (cached !== undefined) {
      return cached;
    }

    let project = basename(normalizedDirectory);
    try {
      const originUrl = execSync(
        `git -C ${shellQuote(normalizedDirectory)} remote get-url origin`,
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }
      );
      const repoName = parseRepoName(originUrl);

      if (repoName) {
        project = repoName;
      }
    } catch {}

    this.inferredProjects.set(normalizedDirectory, project);
    return project;
  }

  private getSnapshotPath(project: string): string {
    if (this.config.dbPath === ":memory:") {
      return join(tmpdir(), `${project}-snapshot.md`);
    }

    return join(dirname(resolve(this.config.dbPath)), `${project}-snapshot.md`);
  }

  private loadRelevantWikiPages(
    project: string,
    taskHintKeywords: string[]
  ): SessionStartWikiPage[] {
    if (taskHintKeywords.length === 0) {
      return [];
    }

    const query = taskHintKeywords.slice(0, 5).join(" OR ");
    const rows = this.repository.db
      .prepare<[string, string, string, string], SessionWikiSearchRow>(
        `SELECT
           wiki_pages.slug AS slug,
           wiki_pages.title AS title,
           wiki_pages.summary AS summary,
           wiki_pages.page_type AS page_type,
           wiki_pages.updated_at AS updated_at,
           bm25(wiki_pages_fts) AS rank
         FROM wiki_pages_fts
         JOIN wiki_pages ON wiki_pages.rowid = wiki_pages_fts.rowid
         WHERE wiki_pages_fts MATCH ?
           AND wiki_pages.project = ?
           AND wiki_pages.status IN (?, ?)
         ORDER BY rank, wiki_pages.updated_at DESC
         LIMIT 3`
      )
      .all(query, project, "published", "stale");

    return rows.map(({ rank: _rank, updated_at: _updatedAt, ...page }) => page);
  }

  private countWikiDrafts(project: string): number {
    const row = this.repository.db
      .prepare<[string, string], CountRow>(
        `SELECT COUNT(*) AS total
         FROM wiki_pages
         WHERE project = ?
           AND status = ?`
      )
      .get(project, "draft");

    return row?.total ?? 0;
  }

  private consumePendingSynthesisWarnings(project: string): string[] {
    const key = `${SESSION_SYNTHESIS_WARNING_PREFIX}${project}`;
    const warning = this.repository.getMetadata(key);

    if (warning === null) {
      return [];
    }

    this.repository.deleteMetadata(key);
    return [warning];
  }

  private updatePendingSynthesisWarning(project: string, memoryIds: string[]): void {
    const key = `${SESSION_SYNTHESIS_WARNING_PREFIX}${project}`;
    const tagCounts = new Map<string, number>();

    for (const memoryId of memoryIds) {
      const memory = this.repository.getMemory(memoryId);
      if (memory === null || memory.status !== "active") {
        continue;
      }

      for (const tag of [...new Set(memory.tags.map((item) => item.trim().toLowerCase()))]) {
        if (tag.length === 0) {
          continue;
        }

        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    const candidate = [...tagCounts.entries()]
      .filter(([, count]) => count >= 3)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];

    if (!candidate) {
      this.repository.deleteMetadata(key);
      return;
    }

    this.repository.setMetadata(
      key,
      `New memories may warrant Wiki synthesis. Run: vega wiki synthesize --topic ${candidate[0]}`
    );
  }
}
