import type { VegaConfig } from "../config.js";
import type { SearchOptions, SearchResult } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { cosineSimilarity } from "../embedding/ollama.js";
import { computeFinalScore, computeRecency, getDecayRate, hybridSearch } from "./ranking.js";

const CHUNK_SIZE = 100;

const toFloat32Array = (embedding: Buffer): Float32Array =>
  new Float32Array(
    embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength)
  );

const rankResults = (results: SearchResult[]): SearchResult[] =>
  results
    .filter((result) => result.memory.verified !== "rejected")
    .map((result) => ({
      ...result,
      finalScore: computeFinalScore(
        result.similarity,
        result.memory.importance,
        computeRecency(result.memory.accessed_at, getDecayRate(result.memory.type)),
        result.memory.verified
      )
    }))
    .sort((left, right) => right.finalScore - left.finalScore);

export class StreamingSearch {
  private lastBm25ResultCount = 0;

  constructor(
    private readonly repository: Repository,
    private readonly _config: VegaConfig
  ) {}

  getLastMetrics(): { bm25ResultCount: number } {
    return {
      bm25ResultCount: this.lastBm25ResultCount
    };
  }

  async *searchStream(
    query: string,
    queryEmbedding: Float32Array | null,
    options: SearchOptions
  ): AsyncGenerator<SearchResult> {
    const bm25Results = this.repository.searchFTS(query, options.project, options.type, true);
    this.lastBm25ResultCount = bm25Results.length;
    const emittedIds = new Set<string>();
    let emittedCount = 0;

    if (queryEmbedding !== null) {
      const totalEmbeddings = this.repository.countEmbeddings(options.project, options.type, true);

      for (let offset = 0; offset < totalEmbeddings && emittedCount < options.limit; offset += CHUNK_SIZE) {
        const chunk = this.repository.getEmbeddingChunk(
          offset,
          CHUNK_SIZE,
          options.project,
          options.type,
          true
        );
        const vectorResults = chunk
          .map(({ embedding, memory }) => ({
            memory,
            similarity: cosineSimilarity(queryEmbedding, toFloat32Array(embedding)),
            finalScore: 0
          }))
          .filter((result) => result.similarity >= options.minSimilarity);
        const chunkBm25Results = bm25Results.filter((result) =>
          vectorResults.some((candidate) => candidate.memory.id === result.memory.id)
        );
        const rankedChunk = rankResults(hybridSearch(vectorResults, chunkBm25Results));

        for (const result of rankedChunk) {
          if (emittedIds.has(result.memory.id)) {
            continue;
          }

          emittedIds.add(result.memory.id);
          emittedCount += 1;
          yield result;

          if (emittedCount >= options.limit) {
            return;
          }
        }

        await Promise.resolve();
      }
    }

    const remainingBm25Results = bm25Results.filter((result) => !emittedIds.has(result.memory.id));
    for (const result of rankResults(hybridSearch([], remainingBm25Results))) {
      emittedCount += 1;
      yield result;

      if (emittedCount >= options.limit) {
        return;
      }
    }
  }
}
