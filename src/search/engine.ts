import type { VegaConfig } from "../config.js";
import type { SearchOptions, SearchResult } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { BruteForceEngine } from "./brute-force.js";
import { computeFinalScore, computeRecency, getDecayRate, hybridSearch } from "./ranking.js";

export class SearchEngine {
  private readonly bruteForceEngine: BruteForceEngine;

  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {
    this.bruteForceEngine = new BruteForceEngine();
  }

  search(query: string, queryEmbedding: Float32Array | null, options: SearchOptions): SearchResult[] {
    const vectorResults =
      queryEmbedding === null
        ? []
        : this.bruteForceEngine.search(
            queryEmbedding,
            this.repository.getAllEmbeddings(options.project, options.type),
            options
          );
    const bm25Results = this.repository.searchFTS(query, options.project, options.type);

    const mergedResults =
      bm25Results.length > 0
        ? hybridSearch(vectorResults, bm25Results)
        : vectorResults;

    return mergedResults
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
  }
}
