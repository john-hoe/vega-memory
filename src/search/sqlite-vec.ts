import { randomUUID } from "node:crypto";

import type { SearchOptions, SearchResult } from "../core/types.js";
import { cosineSimilarity } from "../embedding/ollama.js";
import { Repository } from "../db/repository.js";

const toFloat32Array = (embedding: Buffer): Float32Array =>
  new Float32Array(embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength));

const toVectorJson = (values: Float32Array): string => JSON.stringify(Array.from(values));

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

    const candidates = this.repository
      .getAllEmbeddings()
      .map((entry) => ({
        ...entry,
        vector: toFloat32Array(entry.embedding)
      }));
    const dimension = candidates[0]?.vector.length ?? null;
    const usableCandidates =
      dimension === null
        ? []
        : candidates.filter((entry) => entry.vector.length === dimension);
    const signature = usableCandidates
      .map((entry) => `${entry.id}:${entry.memory.updated_at}:${entry.vector.length}`)
      .join("|");

    if (signature === this.indexSignature) {
      return usableCandidates.length;
    }

    this.repository.db.exec(`DROP TABLE IF EXISTS temp.${this.indexTableName}`);
    this.indexSignature = signature;
    this.indexedCandidates = usableCandidates;
    this.indexDimension = dimension;

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

    return usableCandidates.length;
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
       ORDER BY distance
       LIMIT ?`
    );
    const queryLimit = Math.max(options.limit * 4, options.limit);

    return queryStatement
      .all(toVectorJson(queryEmbedding), queryLimit)
      .map(({ rowid }) => {
        const candidate = this.indexedCandidates[rowid - 1];

        if (!candidate) {
          return null;
        }

        return {
          memory: candidate.memory,
          similarity: cosineSimilarity(queryEmbedding, candidate.vector),
          finalScore: 0
        };
      })
      .filter((result): result is SearchResult => result !== null)
      .filter((result) => {
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
      })
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, options.limit);
  }
}
