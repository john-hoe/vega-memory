import type { VegaConfig } from "../config.js";
import type { Memory, MemoryListFilters, SearchOptions, SearchResult } from "./types.js";
import { Repository } from "../db/repository.js";
import { generateEmbedding } from "../embedding/ollama.js";
import { SearchEngine } from "../search/engine.js";
import { StreamingSearch } from "../search/streaming.js";

const now = (): string => new Date().toISOString();

const unique = (values: string[]): string[] => [...new Set(values)];

const logRecallInfo = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

interface SearchEngineExecution {
  results: SearchResult[];
  bm25ResultCount: number;
}

export class RecallService {
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

    this.repository.updateMemory(
      result.memory.id,
      {
        accessed_at: accessedAt,
        access_count: result.memory.access_count + 1,
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
    const embedding = await generateEmbedding(query, this.config);
    const execution = this.executeSearch(query, embedding, options);
    const results = execution.results;
    const accessedAt = now();

    for (const result of results) {
      this.updateAccessedMemory(result, options.project, accessedAt);
    }

    this.logRecallPerformance("recall", startedAt, options, results, execution.bm25ResultCount);

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
