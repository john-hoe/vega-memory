import { randomUUID } from "node:crypto";

import type { SearchOptions, SearchResult } from "../core/types.js";
import { cosineSimilarity } from "../embedding/ollama.js";
import { Repository } from "../db/repository.js";

const toFloat32Array = (embedding: Buffer): Float32Array =>
  new Float32Array(embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength));

const toVectorJson = (values: Float32Array): string => JSON.stringify(Array.from(values));

const supportsOptions = (result: SearchResult, options: SearchOptions): boolean => {
  if (
    options.project &&
    result.memory.project !== options.project &&
    result.memory.scope !== "global"
  ) {
    return false;
  }

  if (options.type && result.memory.type !== options.type) {
    return false;
  }

  if (options.tenant_id !== undefined && options.tenant_id !== null && result.memory.tenant_id !== options.tenant_id) {
    return false;
  }

  return result.similarity >= options.minSimilarity;
};

const getDominantDimension = (vectors: Float32Array[]): number | null => {
  const counts = new Map<number, number>();
  let dominantDimension: number | null = null;
  let dominantCount = 0;

  for (const vector of vectors) {
    if (vector.length === 0) {
      continue;
    }

    const nextCount = (counts.get(vector.length) ?? 0) + 1;
    counts.set(vector.length, nextCount);

    if (dominantDimension === null || nextCount > dominantCount) {
      dominantDimension = vector.length;
      dominantCount = nextCount;
    }
  }

  return dominantDimension;
};

const getExtensionCandidates = (): string[] => {
  const suffix = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";

  return [...new Set([
    process.env.VEGA_SQLITE_VEC_PATH,
    process.env.SQLITE_VEC_PATH,
    `./vec0${suffix}`,
    `./sqlite-vec${suffix}`,
    `vec0${suffix}`,
    `sqlite-vec${suffix}`,
    "./vec0",
    "./sqlite-vec",
    "vec0",
    "sqlite-vec"
  ])].filter((value): value is string => Boolean(value));
};

export class SqliteVecEngine {
  private static cachedExtensionPath: string | null | undefined;
  private availabilityChecked = false;
  private available = false;
  private readonly indexTableName = `vega_vec_${randomUUID().replace(/-/g, "_")}`;
  private indexedCandidates: Array<{
    id: string;
    memory: SearchResult["memory"];
    vector: Float32Array;
  }> = [];
  private indexSignature = "";
  private indexDimension: number | null = null;
  private indexedCount = 0;

  constructor(private readonly repository: Repository) {}

  isAvailable(): boolean {
    if (this.availabilityChecked) {
      return this.available;
    }

    this.availabilityChecked = true;
    const cachedExtensionPath = SqliteVecEngine.cachedExtensionPath;

    if (cachedExtensionPath === null) {
      this.available = false;
      return false;
    }

    if (cachedExtensionPath !== undefined) {
      try {
        this.repository.db.loadExtension(cachedExtensionPath);
        this.available = true;
        return true;
      } catch {
        SqliteVecEngine.cachedExtensionPath = undefined;
      }
    }

    for (const candidate of getExtensionCandidates()) {
      try {
        this.repository.db.loadExtension(candidate);
        SqliteVecEngine.cachedExtensionPath = candidate;
        this.available = true;
        return true;
      } catch {
        continue;
      }
    }

    SqliteVecEngine.cachedExtensionPath = null;
    this.available = false;
    return false;
  }

  createIndex(): number {
    if (!this.isAvailable()) {
      throw new Error("sqlite-vec not available");
    }

    const snapshot = this.repository.getEmbeddingIndexSnapshot();
    const signature = `${snapshot.count}:${snapshot.latestUpdatedAt ?? "none"}:${snapshot.totalBytes}`;
    if (signature === this.indexSignature) {
      return this.indexedCount;
    }

    const candidates = this.repository
      .getAllEmbeddings()
      .map((entry) => ({
        ...entry,
        vector: toFloat32Array(entry.embedding)
      }));
    const dimension = getDominantDimension(candidates.map((entry) => entry.vector));
    const usableCandidates =
      dimension === null
        ? []
        : candidates.filter((entry) => entry.vector.length === dimension);

    this.repository.db.exec(`DROP TABLE IF EXISTS temp.${this.indexTableName}`);
    this.indexSignature = signature;
    this.indexedCandidates = usableCandidates;
    this.indexDimension = dimension;
    this.indexedCount = usableCandidates.length;

    if (usableCandidates.length === 0 || dimension === null) {
      return 0;
    }

    this.repository.db.exec(
      `CREATE VIRTUAL TABLE temp.${this.indexTableName} USING vec0(embedding float[${dimension}])`
    );
    const insertStatement = this.repository.db.prepare<[number, string]>(
      `INSERT INTO temp.${this.indexTableName}(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`
    );

    this.repository.db.transaction(() => {
      usableCandidates.forEach((candidate, index) => {
        const rowid = index + 1;

        if (!Number.isSafeInteger(rowid)) {
          throw new Error(`vec0 rowid must be a safe integer: ${rowid}`);
        }

        insertStatement.run(rowid, toVectorJson(candidate.vector));
      });
    });

    return this.indexedCount;
  }

  rebuildIndex(): number {
    if (!this.isAvailable()) {
      throw new Error("sqlite-vec not available");
    }

    this.repository.db.exec(`DROP TABLE IF EXISTS temp.${this.indexTableName}`);
    this.indexSignature = "";
    this.indexedCandidates = [];
    this.indexDimension = null;
    this.indexedCount = 0;
    return this.createIndex();
  }

  search(queryEmbedding: Float32Array, options: SearchOptions): SearchResult[] {
    if (!this.isAvailable()) {
      throw new Error("sqlite-vec not available");
    }

    if (this.createIndex() === 0 || this.indexDimension !== queryEmbedding.length) {
      return [];
    }
    const queryStatement = this.repository.db.prepare<[string, number], { rowid: number; distance: number }>(
      `SELECT rowid, distance
       FROM temp.${this.indexTableName}
       WHERE embedding MATCH ?
         AND k = CAST(? AS INTEGER)
       ORDER BY distance
      `
    );
    const batchSize = Math.max(options.limit * 4, 32);
    const results: SearchResult[] = [];
    let processedCount = 0;
    const queryVector = toVectorJson(queryEmbedding);
    const usesOffsetBatches = queryStatement.all.length >= 3;
    const queryBatch = (neighborCount: number): Array<{ rowid: number; distance: number }> =>
      usesOffsetBatches
        ? (
            queryStatement.all as (
              query: string,
              limit: number,
              offset: number
            ) => Array<{ rowid: number; distance: number }>
          )(queryVector, neighborCount, processedCount)
        : queryStatement.all(queryVector, neighborCount);

    for (let requestedCount = batchSize; processedCount < this.indexedCount; requestedCount += batchSize) {
      const neighborCount = Math.min(requestedCount, this.indexedCount);
      const batch = queryBatch(neighborCount);

      if (batch.length === 0) {
        break;
      }

      const nextMatches = usesOffsetBatches ? batch : batch.slice(processedCount);

      if (nextMatches.length === 0) {
        break;
      }

      for (const { rowid } of nextMatches) {
        const candidate = this.indexedCandidates[rowid - 1];

        if (!candidate) {
          continue;
        }

        const result: SearchResult = {
          memory: candidate.memory,
          similarity: cosineSimilarity(queryEmbedding, candidate.vector),
          finalScore: 0
        };

        if (!supportsOptions(result, options)) {
          continue;
        }

        results.push(result);
      }

      processedCount = usesOffsetBatches ? processedCount + nextMatches.length : batch.length;
    }

    return results.sort((left, right) => right.similarity - left.similarity).slice(0, options.limit);
  }
}
