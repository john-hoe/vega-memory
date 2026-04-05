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
      `INSERT INTO temp.${this.indexTableName}(rowid, embedding) VALUES (?, ?)`
    );

    this.repository.db.transaction(() => {
      usableCandidates.forEach((candidate, index) => {
        insertStatement.run(index + 1, toVectorJson(candidate.vector));
      });
    })();

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
    const queryStatement = this.repository.db.prepare<[string, number, number], { rowid: number; distance: number }>(
      `SELECT rowid, distance
       FROM temp.${this.indexTableName}
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ? OFFSET ?`
    );
    const batchSize = Math.max(options.limit * 4, 32);
    const results: SearchResult[] = [];

    for (let offset = 0; offset < this.indexedCount; offset += batchSize) {
      const batch = queryStatement.all(toVectorJson(queryEmbedding), batchSize, offset);

      if (batch.length === 0) {
        break;
      }

      for (const { rowid } of batch) {
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
    }

    return results.sort((left, right) => right.similarity - left.similarity).slice(0, options.limit);
  }
}
