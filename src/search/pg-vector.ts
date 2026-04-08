import type { PgConnectionConfig, PgQueryExecutor } from "../db/pg-executor.js";
import { createPgPoolExecutor } from "../db/pg-executor.js";

export interface PgVectorConfig {
  dimensions: number;
  indexType: "ivfflat" | "hnsw";
  lists?: number;
  m?: number;
  efConstruction?: number;
  connection?: PgConnectionConfig;
  executor?: PgQueryExecutor;
}

export interface PgVectorFilter {
  tenantId?: string;
  project?: string;
}

export interface PgVectorQuery {
  sql: string;
  params: Array<string | number>;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll(`"`, `""`)}"`;
}

function buildIndexParameters(config: PgVectorConfig): string[] {
  if (config.indexType === "ivfflat") {
    return config.lists === undefined ? [] : [`lists = ${config.lists}`];
  }

  const parameters: string[] = [];

  if (config.m !== undefined) {
    parameters.push(`m = ${config.m}`);
  }

  if (config.efConstruction !== undefined) {
    parameters.push(`ef_construction = ${config.efConstruction}`);
  }

  return parameters;
}

export class PgVectorSearch {
  private tableName = "memories";

  private readonly executor: PgQueryExecutor | null;

  constructor(private config: PgVectorConfig) {
    this.executor =
      config.executor ?? (config.connection ? createPgPoolExecutor(config.connection) : null);
  }

  async createIndex(tableName: string): Promise<void> {
    this.tableName = tableName;
    if (this.executor === null) {
      process.stderr.write(`${this.generateIndexDDL()}\n`);
      return;
    }

    await this.executor.query(this.generateIndexDDL());
  }

  async search(
    embedding: number[],
    limit: number,
    filter?: PgVectorFilter
  ): Promise<{ id: string; distance: number }[]> {
    if (this.executor === null) {
      throw new Error("PgVector execution requires an async PostgreSQL adapter");
    }

    const query = this.generateSearchSQL(embedding, limit, filter);
    const result = await this.executor.query<{ id: string; distance: number }>(
      query.sql,
      query.params
    );

    return result.rows;
  }

  async upsert(id: string, embedding: number[], metadata?: Record<string, unknown>): Promise<void> {
    if (this.executor === null) {
      return;
    }

    const query = this.generateUpsertSQL(id, embedding, metadata);
    await this.executor.query(query.sql, query.params);
  }

  async delete(id: string): Promise<void> {
    if (this.executor === null) {
      return;
    }

    const query = this.generateDeleteSQL(id);
    await this.executor.query(query.sql, query.params);
  }

  generateIndexDDL(): string {
    const quotedTableName = quoteIdentifier(this.tableName);
    const quotedIndexName = quoteIdentifier(
      `${this.tableName}_embedding_${this.config.indexType}_idx`
    );
    const parameters = buildIndexParameters(this.config);
    const withClause = parameters.length === 0 ? "" : ` WITH (${parameters.join(", ")})`;

    return `CREATE INDEX IF NOT EXISTS ${quotedIndexName} ON ${quotedTableName} USING ${this.config.indexType} (embedding vector_cosine_ops)${withClause};`;
  }

  generateSearchSQL(
    embedding: number[],
    limit: number,
    filter?: PgVectorFilter
  ): PgVectorQuery {
    const params: Array<string | number> = [this.serializeEmbedding(embedding)];
    const clauses: string[] = [];

    if (filter?.tenantId) {
      clauses.push(`tenant_id = $${params.length + 1}`);
      params.push(filter.tenantId);
    }

    if (filter?.project) {
      clauses.push(`project = $${params.length + 1}`);
      params.push(filter.project);
    }

    params.push(Math.max(1, Math.trunc(limit)));
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const quotedTableName = quoteIdentifier(this.tableName);

    return {
      sql: [
        `SELECT id, embedding <=> $1::vector AS distance`,
        `FROM ${quotedTableName}`,
        where,
        `ORDER BY embedding <=> $1::vector ASC`,
        `LIMIT $${params.length}`
      ]
        .filter((part) => part.length > 0)
        .join("\n"),
      params
    };
  }

  generateUpsertSQL(
    id: string,
    embedding: number[],
    metadata?: Record<string, unknown>
  ): PgVectorQuery {
    const columns = ["id", "embedding"];
    const params: Array<string | number> = [id, this.serializeEmbedding(embedding)];
    const values = [`$1`, `$2::vector`];
    const updates = [`embedding = EXCLUDED.embedding`];

    for (const [key, value] of Object.entries(metadata ?? {})) {
      if (typeof value !== "string" && typeof value !== "number") {
        continue;
      }

      columns.push(key);
      params.push(value);
      values.push(`$${params.length}`);
      updates.push(`${quoteIdentifier(key)} = EXCLUDED.${quoteIdentifier(key)}`);
    }

    const quotedTableName = quoteIdentifier(this.tableName);

    return {
      sql: [
        `INSERT INTO ${quotedTableName} (${columns.map((column) => quoteIdentifier(column)).join(", ")})`,
        `VALUES (${values.join(", ")})`,
        `ON CONFLICT (${quoteIdentifier("id")}) DO UPDATE`,
        `SET ${updates.join(", ")}`
      ].join("\n"),
      params
    };
  }

  generateDeleteSQL(id: string): PgVectorQuery {
    const quotedTableName = quoteIdentifier(this.tableName);

    return {
      sql: `DELETE FROM ${quotedTableName} WHERE id = $1`,
      params: [id]
    };
  }

  private serializeEmbedding(embedding: number[]): string {
    return `[${embedding.map((value) => Number(value).toString()).join(",")}]`;
  }
}
