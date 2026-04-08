// PostgreSQL adapter stub — replace stub methods with pg/pg-pool calls to connect.

import type { DatabaseAdapter, PreparedStatement } from "./adapter.js";

export interface PostgresConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  schema?: string;
}

const POSTGRES_STUB_ERROR =
  "PostgreSQL execution is not available in the current synchronous adapter — configure VEGA_PG_* and add an approved async driver/runtime bridge";

export class PostgresAdapter implements DatabaseAdapter {
  readonly isPostgres = true;

  constructor(private readonly config: PostgresConfig) {}

  get name(): string {
    const host = this.config.host ?? "localhost";
    const port = this.config.port ?? 5432;
    const database = this.config.database ?? "vega";

    return `postgres://${host}:${port}/${database}`;
  }

  loadExtension(_path: string): void {
    this.fail();
  }

  run(_sql: string, ..._params: unknown[]): void {
    this.fail();
  }

  get<T>(_sql: string, ..._params: unknown[]): T | undefined {
    return this.fail();
  }

  all<T>(_sql: string, ..._params: unknown[]): T[] {
    return this.fail();
  }

  exec(_sql: string): void {
    this.fail();
  }

  prepare<P extends unknown[], R>(_sql: string): PreparedStatement<P, R> {
    return {
      run: (..._params: P): void => {
        this.fail();
      },
      get: (..._params: P): R | undefined => this.fail(),
      all: (..._params: P): R[] => this.fail()
    };
  }

  transaction<T>(_fn: () => T): T {
    return this.fail();
  }

  close(): void {
    this.fail();
  }

  private fail(): never {
    throw new Error(POSTGRES_STUB_ERROR);
  }
}

export { POSTGRES_STUB_ERROR };
