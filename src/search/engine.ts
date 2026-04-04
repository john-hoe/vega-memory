import type { VegaConfig } from "../config.js";
import type { SearchOptions, SearchResult } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { BruteForceEngine } from "./brute-force.js";
import { computeFinalScore, computeRecency, getDecayRate, hybridSearch } from "./ranking.js";
import { SqliteVecEngine } from "./sqlite-vec.js";

export class SearchEngine {
  private readonly bruteForceEngine: BruteForceEngine;
  private readonly sqliteVecEngine: SqliteVecEngine;
  private readonly activeVectorEngine: "brute-force" | "sqlite-vec";
  private slowQueryCount = 0;

  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {
    this.bruteForceEngine = new BruteForceEngine();
    this.sqliteVecEngine = new SqliteVecEngine(repository);
    this.activeVectorEngine = this.sqliteVecEngine.isAvailable() ? "sqlite-vec" : "brute-force";

    console.log(`Vector search engine: ${this.activeVectorEngine}`);

    if (this.activeVectorEngine === "sqlite-vec") {
      const indexed = this.sqliteVecEngine.createIndex();
      console.log(`Vector search auto-upgraded to sqlite-vec with ${indexed} indexed embeddings.`);
    }
  }

  private searchVectors(
    queryEmbedding: Float32Array,
    options: SearchOptions
  ): SearchResult[] {
    if (this.activeVectorEngine === "sqlite-vec") {
      return this.sqliteVecEngine.search(queryEmbedding, options);
    }

    return this.bruteForceEngine.search(
      queryEmbedding,
      this.repository.getAllEmbeddings(options.project, options.type, true),
      options
    );
  }

  private trackQueryLatency(durationMs: number): void {
    if (durationMs > 300) {
      this.slowQueryCount += 1;

      if (this.slowQueryCount === 10) {
        console.log(
          this.activeVectorEngine === "sqlite-vec"
            ? "Search is slow for 10 consecutive queries; rebuild the sqlite-vec index or run `vega benchmark --suite recall`."
            : "Search is slow for 10 consecutive queries; install sqlite-vec or run `vega benchmark --suite recall`."
        );
      }

      return;
    }

    this.slowQueryCount = 0;
  }

  search(query: string, queryEmbedding: Float32Array | null, options: SearchOptions): SearchResult[] {
    const startedAt = Date.now();
    const vectorResults =
      queryEmbedding === null ? [] : this.searchVectors(queryEmbedding, options);
    const bm25Results = this.repository.searchFTS(query, options.project, options.type, true);

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

    return results;
  }
}
