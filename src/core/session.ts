import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";

import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { MemoryService } from "./memory.js";
import { RecallService } from "./recall.js";
import { exportSnapshot } from "./snapshot.js";
import type { Memory, MemoryType, SearchResult, SessionStartResult } from "./types.js";

const AUTO_EXTRACT_PATTERNS: Array<{ type: MemoryType; pattern: RegExp }> = [
  { type: "decision", pattern: /决定|选择|因为|chose|decided/i },
  { type: "pitfall", pattern: /修复|解决|原因|bug|fix|solved/i },
  { type: "preference", pattern: /偏好|习惯|prefer|always use/i },
  { type: "task_state", pattern: /下一步|TODO|接下来|next step/i }
];

const now = (): string => new Date().toISOString();

const estimateTokens = (memories: Memory[]): number =>
  memories.reduce((total, memory) => total + memory.content.length / 4, 0);

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

export class SessionService {
  private readonly sessionStartTimes = new Map<string, string>();

  constructor(
    private readonly repository: Repository,
    private readonly memoryService: MemoryService,
    private readonly recallService: RecallService,
    private readonly config: VegaConfig
  ) {}

  async sessionStart(workingDirectory: string, taskHint?: string): Promise<SessionStartResult> {
    const project = this.inferProject(workingDirectory);
    this.sessionStartTimes.set(project, now());

    const preferences = this.repository.listMemories({
      type: "preference",
      scope: "global",
      limit: 10_000,
      sort: "importance DESC"
    });
    const active_tasks = this.repository.listMemories({
      type: "task_state",
      status: "active",
      project,
      limit: 10_000
    });
    const context = this.repository.listMemories({
      type: "project_context",
      project,
      limit: 10_000
    });
    const relevantResults =
      taskHint && taskHint.trim().length > 0
        ? await this.recallService.recall(taskHint, {
            project,
            limit: 5,
            minSimilarity: 0.3
          })
        : [];
    const allMemories = this.repository.listMemories({
      limit: 10_000,
      sort: "created_at DESC"
    });
    const recent_unverified = allMemories
      .filter((memory) => memory.verified === "unverified")
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
      .slice(0, 3);
    const conflicts = allMemories.filter((memory) => memory.verified === "conflict");
    const proactive_warnings =
      taskHint && taskHint.trim().length > 0
        ? this.repository
            .listMemories({
              type: "insight",
              project,
              limit: 10_000
            })
            .filter((memory) => {
              const keywords = extractTaskHintKeywords(taskHint);
              const tags = memory.tags.map((tag) => tag.toLowerCase());
              return keywords.some((keyword) => tags.includes(keyword));
            })
            .map((memory) => memory.content)
        : [];

    let trimmedRelevantResults = [...relevantResults];
    let token_estimate = estimateTokens([
      ...preferences,
      ...active_tasks,
      ...context,
      ...trimmedRelevantResults.map((result) => result.memory),
      ...recent_unverified,
      ...conflicts
    ]);

    if (token_estimate > this.config.tokenBudget && trimmedRelevantResults.length > 0) {
      const byLowestScoreFirst = [...trimmedRelevantResults].sort(
        (left, right) => left.finalScore - right.finalScore
      );

      while (token_estimate > this.config.tokenBudget && byLowestScoreFirst.length > 0) {
        const removed = byLowestScoreFirst.shift();
        if (!removed) {
          break;
        }

        trimmedRelevantResults = trimmedRelevantResults.filter(
          (result) => result.memory.id !== removed.memory.id
        );
        token_estimate = estimateTokens([
          ...preferences,
          ...active_tasks,
          ...context,
          ...trimmedRelevantResults.map((result) => result.memory),
          ...recent_unverified,
          ...conflicts
        ]);
      }
    }

    return {
      project,
      active_tasks,
      preferences,
      context,
      relevant: [...trimmedRelevantResults]
        .sort((left, right) => right.finalScore - left.finalScore)
        .map((result) => result.memory),
      recent_unverified,
      conflicts,
      proactive_warnings,
      token_estimate
    };
  }

  async sessionEnd(project: string, summary: string, completedTaskIds?: string[]): Promise<void> {
    const ended_at = now();
    const started_at = this.sessionStartTimes.get(project) ?? ended_at;

    for (const taskId of completedTaskIds ?? []) {
      this.repository.updateMemory(taskId, {
        importance: 0.2,
        updated_at: ended_at
      });
    }

    const memories_created: string[] = [];

    for (const sentence of splitSentences(summary)) {
      for (const { type, pattern } of AUTO_EXTRACT_PATTERNS) {
        if (!pattern.test(sentence)) {
          continue;
        }

        const stored = await this.memoryService.store({
          content: sentence,
          type,
          project,
          source: "auto"
        });
        memories_created.push(stored.id);
      }
    }

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
}
