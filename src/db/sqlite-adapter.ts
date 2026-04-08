import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3 from "better-sqlite3-multiple-ciphers";

import type { DatabaseAdapter, PreparedStatement } from "./adapter.js";
import { initializeDatabase } from "./schema.js";

export class SQLiteAdapter implements DatabaseAdapter {
  readonly isPostgres = false;
  private readonly database: BetterSqlite3.Database;

  constructor(database: BetterSqlite3.Database, encryptionKey?: string);
  constructor(dbPath: string, encryptionKey?: string);
  constructor(
    databaseOrPath: BetterSqlite3.Database | string,
    encryptionKey?: string
  ) {
    if (typeof databaseOrPath === "string") {
      if (databaseOrPath !== ":memory:") {
        mkdirSync(dirname(databaseOrPath), { recursive: true });
      }

      this.database = new BetterSqlite3(databaseOrPath);
      if (encryptionKey) {
        this.database.pragma(`key = "x'${encryptionKey}'"`);
      }
      initializeDatabase(this.database);
      return;
    }

    this.database = databaseOrPath;
  }

  get name(): string {
    return this.database.name;
  }

  loadExtension(path: string): void {
    this.database.loadExtension(path);
  }

  run(sql: string, ...params: unknown[]): void {
    this.database.prepare(sql).run(...params);
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.database.prepare<unknown[], T>(sql).get(...params);
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.database.prepare<unknown[], T>(sql).all(...params);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare<P extends unknown[], R>(sql: string): PreparedStatement<P, R> {
    const statement = this.database.prepare<P, R>(sql);

    return {
      run(...params: P): void {
        statement.run(...params);
      },
      get(...params: P): R | undefined {
        return statement.get(...params);
      },
      all(...params: P): R[] {
        return statement.all(...params);
      }
    };
  }

  transaction<T>(fn: () => T): T {
    return this.database.transaction(fn)();
  }

  close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }
}
