import type { PgConnectionConfig, PgQueryExecutor } from "../db/pg-executor.js";
import { createPgPoolExecutor } from "../db/pg-executor.js";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll(`"`, `""`)}"`;
}

function extractTokens(value: string): string[] {
  return Array.from(value.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu), (match) => match[0]);
}

export interface PgFullTextSearchOptions {
  language?: string;
  limit?: number;
  tenantId?: string;
  project?: string;
}

export interface PgFullTextQuery {
  sql: string;
  params: Array<string | number>;
}

export class PgFullTextSearch {
  private readonly executor: PgQueryExecutor | null;

  constructor(config?: { connection?: PgConnectionConfig; executor?: PgQueryExecutor }) {
    this.executor =
      config?.executor ?? (config?.connection ? createPgPoolExecutor(config.connection) : null);
  }

  async search(
    query: string,
    options: PgFullTextSearchOptions
  ): Promise<{ id: string; rank: number }[]> {
    if (this.executor === null) {
      throw new Error("PgFullText execution requires an async PostgreSQL adapter");
    }

    const statement = this.generateSearchSQL(query, options);
    const result = await this.executor.query<{ id: string; rank: number }>(
      statement.sql,
      statement.params
    );

    return result.rows;
  }

  generateTsVectorDDL(tableName: string, columns: string[]): string {
    if (columns.length === 0) {
      throw new Error("PgFullTextSearch requires at least one column");
    }

    const quotedTableName = quoteIdentifier(tableName);
    const vectorColumnName = "search_vector";
    const indexName = quoteIdentifier(`${tableName}_${vectorColumnName}_gin_idx`);
    const documentExpression = columns
      .map((column) => `coalesce(${quoteIdentifier(column)}, '')`)
      .join(` || ' ' || `);

    return [
      `ALTER TABLE ${quotedTableName}`,
      `ADD COLUMN IF NOT EXISTS ${vectorColumnName} tsvector GENERATED ALWAYS AS (to_tsvector('simple', ${documentExpression})) STORED;`,
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${quotedTableName} USING GIN (${vectorColumnName});`
    ].join("\n");
  }

  toTsQuery(query: string, language = "simple"): string {
    void language;

    const parts = Array.from(query.matchAll(/"([^"]+)"|(\S+)/g), (match) => ({
      raw: match[0] ?? "",
      value: match[1] ?? match[2] ?? ""
    }));
    const terms = parts
      .map((part) => {
        const tokens = extractTokens(part.value);

        if (tokens.length === 0) {
          return "";
        }

        if (part.raw.startsWith(`"`)) {
          return tokens.map((token) => `${token}:*`).join(" <-> ");
        }

        return tokens.map((token) => `${token}:*`).join(" & ");
      })
      .filter((part) => part.length > 0);

    return terms.join(" & ");
  }

  generateSearchSQL(
    query: string,
    options: PgFullTextSearchOptions = {}
  ): PgFullTextQuery {
    const language = options.language ?? "simple";
    const tsQuery = this.toTsQuery(query, language);
    const params: Array<string | number> = [tsQuery];
    const clauses = [`search_vector @@ to_tsquery('${language}', $1)`];

    if (options.tenantId) {
      params.push(options.tenantId);
      clauses.push(`tenant_id = $${params.length}`);
    }

    if (options.project) {
      params.push(options.project);
      clauses.push(`project = $${params.length}`);
    }

    params.push(Math.max(1, Math.trunc(options.limit ?? 10)));

    return {
      sql: [
        `SELECT id, ts_rank_cd(search_vector, to_tsquery('${language}', $1)) AS rank`,
        `FROM ${quoteIdentifier("memories")}`,
        `WHERE ${clauses.join(" AND ")}`,
        `ORDER BY rank DESC, updated_at DESC`,
        `LIMIT $${params.length}`
      ].join("\n"),
      params
    };
  }
}
