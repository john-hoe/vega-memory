import { Pool, type QueryResultRow } from "pg";

export interface PgConnectionConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

export interface PgQueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;
}

function getSslConfig(ssl: boolean | undefined): { rejectUnauthorized: false } | false | undefined {
  if (ssl === undefined) {
    return undefined;
  }

  return ssl ? { rejectUnauthorized: false } : false;
}

export function createPgPoolExecutor(config: PgConnectionConfig): PgQueryExecutor {
  const ssl = getSslConfig(config.ssl);
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ...(ssl === undefined ? {} : { ssl })
  });

  return {
    query<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: unknown[] = []
    ): Promise<{ rows: T[] }> {
      return pool.query<T>(sql, params);
    }
  };
}
