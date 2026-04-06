import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";

import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { isOllamaAvailable } from "../embedding/ollama.js";
import { PageManager } from "../wiki/page-manager.js";
import { ExtractionService } from "./extraction.js";
import { MemoryService } from "./memory.js";
import { RecallService } from "./recall.js";
import { exportSnapshot } from "./snapshot.js";
import type {
  AuditContext,
  Memory,
  MemoryType,
  SearchResult,
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
const SESSION_SYNTHESIS_WARNING_PREFIX = "session-synthesis-warning:";

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

const estimateTextTokens = (value: string): number => value.length / 4;

const estimateMemoryTokens = (memory: Memory): number =>
  estimateTextTokens(memory.summary ?? memory.content);

const estimateWikiPageTokens = (page: SessionStartWikiPage): number =>
  estimateTextTokens(`${page.title}\n${page.summary}`);

const estimateTokens = (memories: Memory[]): number =>
  memories.reduce((total, memory) => total + estimateMemoryTokens(memory), 0);

const estimateWikiTokens = (pages: SessionStartWikiPage[]): number =>
  pages.reduce((total, page) => total + estimateWikiPageTokens(page), 0);

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

export class SessionService {
  private readonly sessionStartTimes = new Map<string, string>();
  private readonly extractionService: ExtractionService;

  constructor(
    private readonly repository: Repository,
    private readonly memoryService: MemoryService,
    private readonly recallService: RecallService,
    private readonly config: VegaConfig,
    private readonly pageManager?: PageManager | null
  ) {
    this.extractionService = new ExtractionService(config);
  }

  async sessionStart(workingDirectory: string, taskHint?: string): Promise<SessionStartResult> {
    const project = this.inferProject(workingDirectory);
    this.sessionStartTimes.set(project, now());
    const normalizedTaskHint = taskHint?.trim() ?? "";
    const taskHintKeywords = normalizedTaskHint ? extractTaskHintKeywords(normalizedTaskHint) : [];

    const preferences = this.repository
      .listMemories({
        type: "preference",
        status: "active",
        scope: "global",
        limit: 10_000,
        sort: "importance DESC"
      })
      .filter(isSessionVisible);
    const globalRelevant = [
      ...this.repository.listMemories({
        scope: "global",
        type: "pitfall",
        status: "active",
        limit: 20,
        sort: "importance DESC"
      }),
      ...this.repository.listMemories({
        scope: "global",
        type: "decision",
        status: "active",
        limit: 10,
        sort: "importance DESC"
      }),
      ...this.repository.listMemories({
        scope: "global",
        type: "insight",
        status: "active",
        limit: 10,
        sort: "importance DESC"
      })
    ].filter(isSessionVisible);
    const active_tasks = this.repository
      .listMemories({
        type: "task_state",
        status: "active",
        project,
        limit: 10_000
      })
      .filter(isSessionVisible);
    const context = this.repository
      .listMemories({
        type: "project_context",
        status: "active",
        project,
        limit: 10_000
      })
      .filter(isSessionVisible);
    const relevantResults =
      taskHintKeywords.length > 0
        ? (await this.recallService.recall(normalizedTaskHint, {
            limit: 5,
            minSimilarity: 0.3
          })).map((result) => ({
            ...result,
            finalScore:
              result.memory.project === project ? result.finalScore : result.finalScore * 0.5
          }))
            .filter(
              (result) => isRelevantMemoryType(result.memory) && result.memory.verified !== "conflict"
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
    const allMemories = this.repository.listMemories({
      status: "active",
      limit: 10_000,
      sort: "created_at DESC"
    });
    const relevant_wiki_pages = this.pageManager
      ? this.loadRelevantWikiPages(project, taskHintKeywords)
      : [];
    const wiki_drafts_pending = this.pageManager ? this.countWikiDrafts(project) : 0;
    const recent_unverified = allMemories
      .filter(
        (memory) => memory.verified === "unverified" && isInProjectScope(memory, project)
      )
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
      .slice(0, 3);
    const conflicts = allMemories.filter(
      (memory) => memory.verified === "conflict" && isInProjectScope(memory, project)
    ).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    const proactive_warnings = [
      ...(taskHintKeywords.length
        ? this.repository
            .listMemories({
              type: "insight",
              status: "active",
              limit: 10_000,
              sort: "importance DESC"
            })
            .filter((memory) => {
              if (!isInProjectScope(memory, project) || !isSessionVisible(memory)) {
                return false;
              }

              const tags = memory.tags.map((tag) => tag.toLowerCase());
              return taskHintKeywords.some((keyword) => tags.includes(keyword));
            })
            .map((memory) => memory.content)
        : []),
      ...this.consumePendingSynthesisWarnings(project)
    ];

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

  async sessionEnd(
    project: string,
    summary: string,
    completedTaskIds?: string[],
    auditContext?: AuditContext
  ): Promise<void> {
    const ended_at = now();
    const started_at = this.sessionStartTimes.get(project) ?? ended_at;
    const newlyCreatedMemoryIds: string[] = [];

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
    const ollamaAvailable = await isOllamaAvailable(this.config);
    const extracted = ollamaAvailable
      ? await this.extractionService.extractMemories(summary, project)
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

    exportSnapshot(this.repository, this.getSnapshotPath(project));
    this.sessionStartTimes.delete(project);
  }

  inferProject(workingDirectory: string): string {
    try {
      const originUrl = execSync(
        `git -C ${shellQuote(workingDirectory)} remote get-url origin`,
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }
      );
      const repoName = parseRepoName(originUrl);

      if (repoName) {
        return repoName;
      }
    } catch {}

    return basename(resolve(workingDirectory));
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
