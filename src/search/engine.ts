import type { VegaConfig } from "../config.js";
import type { SearchOptions, SearchResult } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { BruteForceEngine } from "./brute-force.js";
import { computeFinalScore, computeRecency, getDecayRate, hybridSearch } from "./ranking.js";
import { SqliteVecEngine } from "./sqlite-vec.js";

const logSearchInfo = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

export type SearchBackend = "sqlite-fts" | "sqlite-vec" | "brute-force" | "pg-vector" | "pg-fulltext";

interface SearchExecution {
  results: SearchResult[];
  bm25ResultCount: number;
  vectorResultCount: number;
  vectorEngine: SearchBackend;
}

export class SearchEngine {
  private readonly bruteForceEngine: BruteForceEngine;
  private readonly sqliteVecEngine: SqliteVecEngine;
  private activeVectorEngine: SearchBackend = "brute-force";
  private readonly textBackend: SearchBackend = "sqlite-fts";
  private slowQueryCount = 0;

  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {
    this.bruteForceEngine = new BruteForceEngine();
    this.sqliteVecEngine = new SqliteVecEngine(repository);
    if (!this.ensureSqliteVecReady()) {
      logSearchInfo("Vector search engine: brute-force");
    }
  }

  private ensureSqliteVecReady(): boolean {
    if (this.activeVectorEngine === "sqlite-vec") {
      return true;
    }

    if (!this.sqliteVecEngine.isAvailable()) {
      return false;
    }

    const indexed = this.sqliteVecEngine.createIndex();
    this.activeVectorEngine = "sqlite-vec";
    logSearchInfo(`Vector search switched from brute-force to sqlite-vec with ${indexed} indexed embeddings.`);
    return true;
  }

  private searchVectors(
    queryEmbedding: Float32Array,
    options: SearchOptions
  ): SearchResult[] {
    if (options.topic) {
      return this.bruteForceEngine.search(
        queryEmbedding,
        this.repository.getAllEmbeddings(
          options.project,
          options.type,
          true,
          options.tenant_id,
          options.topic
        ),
        options
      );
    }

    if (this.activeVectorEngine === "pg-vector") {
      throw new Error("pg-vector backend is not wired yet");
    }

    if (this.activeVectorEngine === "pg-fulltext" || this.activeVectorEngine === "sqlite-fts") {
      this.activeVectorEngine = "brute-force";
    }

    if (this.ensureSqliteVecReady()) {
      return this.sqliteVecEngine.search(queryEmbedding, options);
    }

    return this.bruteForceEngine.search(
      queryEmbedding,
      this.repository.getAllEmbeddings(options.project, options.type, true, options.tenant_id),
      options
    );
  }

  private searchText(query: string, options: SearchOptions): { memory: SearchResult["memory"]; rank: number }[] {
    switch (this.textBackend) {
      case "pg-fulltext":
        throw new Error("pg-fulltext backend is not wired yet");
      case "sqlite-fts":
        return this.repository.searchFTS(
          query,
          options.project,
          options.type,
          true,
          options.tenant_id,
          options.topic
        );
      case "sqlite-vec":
      case "brute-force":
      case "pg-vector":
        return [];
    }
  }

  private trackQueryLatency(durationMs: number): void {
    if (durationMs > 300) {
      this.slowQueryCount += 1;

      if (this.slowQueryCount === 10) {
        logSearchInfo(
          this.activeVectorEngine === "sqlite-vec"
            ? "Search is slow for 10 consecutive queries; run `vega reindex` or `vega benchmark --suite recall`."
            : "Search is slow for 10 consecutive queries; install sqlite-vec or run `vega benchmark --suite recall`."
        );
      }

      return;
    }

    this.slowQueryCount = 0;
  }

  rebuildIndex(): number {
    if (!this.sqliteVecEngine.isAvailable()) {
      throw new Error("sqlite-vec not available");
    }

    const indexed = this.sqliteVecEngine.rebuildIndex();
    if (this.activeVectorEngine !== "sqlite-vec") {
      this.activeVectorEngine = "sqlite-vec";
      logSearchInfo(`Vector search switched from brute-force to sqlite-vec with ${indexed} indexed embeddings.`);
    }

    return indexed;
  }

  searchDetailed(
    query: string,
    queryEmbedding: Float32Array | null,
    options: SearchOptions
  ): SearchExecution {
    const startedAt = Date.now();
    const vectorResults =
      queryEmbedding === null ? [] : this.searchVectors(queryEmbedding, options);
    const bm25Results = this.searchText(query, options);

    const mergedResults =
      bm25Results.length > 0
        ? hybridSearch(vectorResults, bm25Results)
        : vectorResults;

    const results = mergedResults
      .filter((result) => result.memory.verified !== "rejected")
      .map((result) => {
        const recency = computeRecency(result.memory.accessed_at, getDecayRate(result.memory.type));

        return {
          ...result,
          finalScore: computeFinalScore(
            result.similarity,
            result.memory.importance,
            recency,
            result.memory.verified
          )
        };
      })
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, options.limit);

    this.trackQueryLatency(Date.now() - startedAt);

    return {
      results,
      bm25ResultCount: bm25Results.length,
      vectorResultCount: vectorResults.length,
      vectorEngine: this.activeVectorEngine
    };
  }

  search(query: string, queryEmbedding: Float32Array | null, options: SearchOptions): SearchResult[] {
    return this.searchDetailed(query, queryEmbedding, options).results;
  }
}
