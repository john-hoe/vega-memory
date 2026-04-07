import type { Memory, SearchOptions, SearchResult } from "../core/types.js";
import { cosineSimilarity } from "../embedding/ollama.js";

const toFloat32Array = (embedding: Buffer): Float32Array =>
  new Float32Array(embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength));

export class BruteForceEngine {
  search(
    queryEmbedding: Float32Array,
    allEmbeddings: { id: string; embedding: Buffer; memory: Memory }[],
    options: SearchOptions
  ): SearchResult[] {
    return allEmbeddings
      .filter(({ memory }) => {
        if (
          options.project &&
          memory.project !== options.project &&
          memory.scope !== "global"
        ) {
          return false;
        }

        if (options.type && memory.type !== options.type) {
          return false;
        }

        if (options.tenant_id !== undefined && options.tenant_id !== null && memory.tenant_id !== options.tenant_id) {
          return false;
        }

        return true;
      })
      .map(({ memory, embedding }) => ({
        memory,
        similarity: cosineSimilarity(queryEmbedding, toFloat32Array(embedding)),
        finalScore: 0
      }))
      .filter((result) => result.similarity >= options.minSimilarity)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, options.limit);
  }
}
