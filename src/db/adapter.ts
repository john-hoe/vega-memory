export interface PreparedStatement<P extends unknown[], R> {
  run(...params: P): void;
  get(...params: P): R | undefined;
  all(...params: P): R[];
}

export interface DatabaseAdapter {
  run(sql: string, ...params: unknown[]): void;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  exec(sql: string): void;
  prepare<P extends unknown[] = unknown[], R = unknown>(sql: string): PreparedStatement<P, R>;
  transaction<T>(fn: () => T): T;
  close(): void;
  readonly isPostgres: boolean;
}
