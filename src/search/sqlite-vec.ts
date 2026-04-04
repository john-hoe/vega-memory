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
  private availabilityChecked = false;
  private available = false;

  constructor(private readonly repository: Repository) {}

  isAvailable(): boolean {
    if (this.availabilityChecked) {
      return this.available;
    }

    this.availabilityChecked = true;

    for (const candidate of getExtensionCandidates()) {
      try {
        this.repository.db.loadExtension(candidate);
        this.available = true;
        return true;
      } catch {
        continue;
      }
    }

    this.available = false;
    return false;
  }

  search(queryEmbedding: Float32Array, options: SearchOptions): SearchResult[] {
    if (!this.isAvailable()) {
      throw new Error("sqlite-vec not available");
    }

    const candidates = this.repository
      .getAllEmbeddings(options.project, options.type)
      .map((entry) => ({
        ...entry,
        vector: toFloat32Array(entry.embedding)
      }))
      .filter((entry) => entry.vector.length === queryEmbedding.length);

    if (candidates.length === 0) {
      return [];
    }

    const tableName = `vega_vec_${randomUUID().replace(/-/g, "_")}`;
    const createTableSql =
      `CREATE VIRTUAL TABLE temp.${tableName} USING vec0(embedding float[${queryEmbedding.length}])`;
    const insertStatement = this.repository.db.prepare<[number, string]>(
      `INSERT INTO temp.${tableName}(rowid, embedding) VALUES (?, ?)`
    );
    const queryStatement = this.repository.db.prepare<[string, number], { rowid: number; distance: number }>(
      `SELECT rowid, distance
       FROM temp.${tableName}
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    );

    this.repository.db.exec(createTableSql);

    try {
      this.repository.db.transaction(() => {
        candidates.forEach((candidate, index) => {
          insertStatement.run(index + 1, toVectorJson(candidate.vector));
        });
      })();

      const queryLimit = Math.max(options.limit * 4, options.limit);

      return queryStatement
        .all(toVectorJson(queryEmbedding), queryLimit)
        .map(({ rowid }) => {
          const candidate = candidates[rowid - 1];
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
        .filter((result) => result.similarity >= options.minSimilarity)
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, options.limit);
    } finally {
      this.repository.db.exec(`DROP TABLE IF EXISTS temp.${tableName}`);
    }
  }
}
