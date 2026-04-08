import type { VegaConfig } from "../config.js";
import type { Memory, MemoryListFilters, SearchOptions, SearchResult } from "./types.js";
import { Repository } from "../db/repository.js";
import { generateEmbedding } from "../embedding/ollama.js";
import { SearchEngine } from "../search/engine.js";
import { StreamingSearch } from "../search/streaming.js";

const now = (): string => new Date().toISOString();
const ACCESS_UPDATE_DEBOUNCE_MS = 60_000;
const PERFORMANCE_LOG_DEBOUNCE_MS = 1_000;
const RECALL_CACHE_TTL_MS = 2_000;

const unique = (values: string[]): string[] => [...new Set(values)];

const logRecallInfo = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

interface SearchEngineExecution {
  results: SearchResult[];
  bm25ResultCount: number;
}

export class RecallService {
  private readonly performanceLogTimes = new Map<string, number>();
  private readonly recallCache = new Map<
    string,
    {
      cachedAt: number;
      results: SearchResult[];
      bm25ResultCount: number;
    }
  >();

  constructor(
    private readonly repository: Repository,
    private readonly searchEngine: SearchEngine,
    private readonly config: VegaConfig
  ) {}

  private logRecallPerformance(
    operation: "recall" | "recall_stream",
    startedAt: number,
    options: SearchOptions,
    results: SearchResult[],
    bm25ResultCount: number
  ): void {
    const logKey = `${operation}\u0000${options.project ?? ""}\u0000${options.tenant_id ?? ""}`;
    const lastLoggedAt = this.performanceLogTimes.get(logKey) ?? 0;
    const currentTime = Date.now();
    if (currentTime - lastLoggedAt < PERFORMANCE_LOG_DEBOUNCE_MS) {
      return;
    }
    this.performanceLogTimes.set(logKey, currentTime);

    const avgSimilarity =
      results.length === 0
        ? null
        : results.reduce((sum, result) => sum + result.similarity, 0) / results.length;

    this.repository.logPerformance({
      timestamp: now(),
      tenant_id: options.tenant_id ?? null,
      operation,
      latency_ms: Date.now() - startedAt,
      memory_count: this.repository.countActiveMemories(options.project, options.type, true, options.tenant_id),
      result_count: results.length,
      avg_similarity: avgSimilarity,
      result_types: results.map((result) => result.memory.type),
      bm25_result_count: bm25ResultCount
    });
  }

  private updateAccessedMemory(result: SearchResult, project: string | undefined, accessedAt: string): void {
    const accessedProjects = unique([...result.memory.accessed_projects, project ?? result.memory.project]);
    const shouldPromote = result.memory.scope === "project" && accessedProjects.length >= 2;
    const lastAccessedAt = Date.parse(result.memory.accessed_at);
    const shouldRefreshAccess =
      Number.isNaN(lastAccessedAt) ||
      Date.parse(accessedAt) - lastAccessedAt >= ACCESS_UPDATE_DEBOUNCE_MS;

    if (!shouldPromote && !shouldRefreshAccess) {
      return;
    }

    this.repository.updateMemory(
      result.memory.id,
      {
        accessed_at: accessedAt,
        access_count: result.memory.access_count + (shouldRefreshAccess ? 1 : 0),
        accessed_projects: accessedProjects,
        ...(shouldPromote ? { scope: "global" as const } : {})
      },
      {
        skipVersion: true
      }
    );

    if (shouldPromote) {
      logRecallInfo(
        `Memory ${result.memory.id} promoted to global scope (accessed by ${accessedProjects.length} projects)`
      );
    }
  }

  private executeSearch(
    query: string,
    embedding: Float32Array | null,
    options: SearchOptions
  ): SearchEngineExecution {
    const searchEngine = this.searchEngine as SearchEngine & {
      searchDetailed?: (
        queryText: string,
        queryEmbedding: Float32Array | null,
        searchOptions: SearchOptions
      ) => SearchEngineExecution;
    };

    if (typeof searchEngine.searchDetailed === "function") {
      return searchEngine.searchDetailed(query, embedding, options);
    }

    return {
      results: this.searchEngine.search(query, embedding, options),
      bm25ResultCount: 0
    };
  }

  async recall(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const startedAt = Date.now();
    const cacheKey = JSON.stringify({
      query,
      project: options.project ?? null,
      type: options.type ?? null,
      limit: options.limit,
      minSimilarity: options.minSimilarity ?? null,
      tenant_id: options.tenant_id ?? null
    });
    const cached = this.recallCache.get(cacheKey);
    const execution =
      cached && Date.now() - cached.cachedAt < RECALL_CACHE_TTL_MS
        ? {
            results: structuredClone(cached.results) as SearchResult[],
            bm25ResultCount: cached.bm25ResultCount
          }
        : (() => {
            const embeddingPromise = generateEmbedding(query, this.config);
            return {
              embeddingPromise
            };
          })();
    let resolvedExecution: SearchEngineExecution;
    if ("results" in execution) {
      resolvedExecution = execution;
    } else {
      const embedding = await execution.embeddingPromise;
      resolvedExecution = this.executeSearch(query, embedding, options);
      this.recallCache.set(cacheKey, {
        cachedAt: Date.now(),
        results: structuredClone(resolvedExecution.results) as SearchResult[],
        bm25ResultCount: resolvedExecution.bm25ResultCount
      });
    }
    const results = resolvedExecution.results;
    const accessedAt = now();

    for (const result of results) {
      this.updateAccessedMemory(result, options.project, accessedAt);
    }

    this.logRecallPerformance("recall", startedAt, options, results, resolvedExecution.bm25ResultCount);

    return results;
  }

  async *recallStream(query: string, options: SearchOptions): AsyncGenerator<SearchResult> {
    const startedAt = Date.now();
    const embedding = await generateEmbedding(query, this.config);
    const results: SearchResult[] = [];
    const streamingSearch = new StreamingSearch(this.repository, this.config);

    try {
      for await (const result of streamingSearch.searchStream(query, embedding, options)) {
        this.updateAccessedMemory(result, options.project, now());
        results.push(result);
        yield result;
      }
    } finally {
      this.logRecallPerformance(
        "recall_stream",
        startedAt,
        options,
        results,
        streamingSearch.getLastMetrics().bm25ResultCount
      );
    }
  }

  listMemories(filters: MemoryListFilters): Memory[] {
    return this.repository.listMemories(filters);
  }
}
