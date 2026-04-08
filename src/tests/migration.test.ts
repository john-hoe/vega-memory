import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import Database from "better-sqlite3-multiple-ciphers";

import type { MigrationData } from "../db/migration.js";
import { MigrationTool } from "../db/migration.js";

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");
const cliModuleUrl = pathToFileURL(cliPath).href;
const childBaseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("VEGA_") && key !== "OLLAMA_BASE_URL" && key !== "OLLAMA_MODEL"
  )
);
const cliBootstrap = `process.argv.splice(1, 0, ${JSON.stringify(cliPath)}); await import(${JSON.stringify(cliModuleUrl)});`;

const runCli = (args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync(process.execPath, ["--input-type=module", "-e", cliBootstrap, "--", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...childBaseEnv,
      ...env
    }
  });

const createSqliteDatabase = (
  prefix: string,
  setup: (database: Database.Database) => void
): { tempDir: string; dbPath: string } => {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(tempDir, "source.db");
  const database = new Database(dbPath);

  try {
    setup(database);
  } finally {
    database.close();
  }

  return { tempDir, dbPath };
};

test("MigrationTool maps SQLite types to PostgreSQL types", () => {
  const { tempDir, dbPath } = createSqliteDatabase("vega-migration-types-", (database) => {
    database.exec(`
      CREATE TABLE items (
        id INTEGER NOT NULL,
        body TEXT,
        score REAL,
        payload BLOB,
        active BOOLEAN DEFAULT 1
      );
    `);
  });
  const tool = new MigrationTool();

  try {
    const data = tool.exportSqlite(dbPath);
    const statements = tool.generatePgSql(data).join("\n");

    assert.match(statements, /"id" bigint NOT NULL/);
    assert.match(statements, /"body" text/);
    assert.match(statements, /"score" double precision/);
    assert.match(statements, /"payload" bytea/);
    assert.match(statements, /"active" boolean DEFAULT 1/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("MigrationTool skips FTS5 virtual tables and emits tsvector DDL", () => {
  const { tempDir, dbPath } = createSqliteDatabase("vega-migration-fts-", (database) => {
    database.exec(`
      CREATE TABLE memories (
        id INTEGER NOT NULL,
        title TEXT,
        content TEXT
      );
      CREATE VIRTUAL TABLE memories_fts
      USING fts5(title, content, content=memories, content_rowid=rowid);
    `);
  });
  const tool = new MigrationTool();

  try {
    const data = tool.exportSqlite(dbPath);
    const tableNames = data.tables.map((table) => table.name);
    const statements = tool.generatePgSql(data).join("\n\n");

    assert.deepEqual(tableNames, ["memories"]);
    assert.match(statements, /ALTER TABLE "memories"/);
    assert.match(statements, /ADD COLUMN IF NOT EXISTS search_vector tsvector/);
    assert.match(statements, /CREATE INDEX IF NOT EXISTS "memories_search_vector_gin_idx"/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("MigrationTool emits pgvector SQL when migration data includes vector columns", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-migration-vec-"));
  const tool = new MigrationTool();
  const data: MigrationData = {
    tables: [
      {
        name: "embeddings",
        columns: [
          {
            name: "embedding",
            type: "BLOB",
            nullable: true,
            defaultValue: null,
            vectorDimensions: 3
          }
        ]
      }
    ],
    indexes: [],
    rowCounts: {
      embeddings: 1
    }
  };

  try {
    const statements = tool.generatePgSql(data).join("\n\n");

    assert.equal(data.rowCounts.embeddings, 1);
    assert.match(statements, /CREATE EXTENSION IF NOT EXISTS vector;/);
    assert.match(statements, /CREATE TABLE IF NOT EXISTS "embeddings"/);
    assert.match(statements, /"embedding" vector\(3\)/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("MigrationTool.validateMigration reports pass and fail cases", () => {
  const source: MigrationData = {
    tables: [
      {
        name: "memories",
        columns: [
          {
            name: "id",
            type: "INTEGER",
            nullable: false,
            defaultValue: null
          },
          {
            name: "content",
            type: "TEXT",
            nullable: true,
            defaultValue: null
          }
        ]
      }
    ],
    indexes: [
      {
        name: "memories_content_idx",
        tableName: "memories",
        columns: ["content"],
        unique: false,
        kind: "btree"
      }
    ],
    rowCounts: {
      memories: 2
    }
  };
  const passingTarget: MigrationData = {
    tables: [
      {
        name: "memories",
        columns: [
          {
            name: "id",
            type: "bigint",
            nullable: false,
            defaultValue: null
          },
          {
            name: "content",
            type: "text",
            nullable: true,
            defaultValue: null
          }
        ]
      }
    ],
    indexes: [
      {
        name: "memories_content_idx",
        tableName: "memories",
        columns: ["content"],
        unique: false,
        kind: "btree"
      }
    ],
    rowCounts: {
      memories: 2
    }
  };
  const failingTarget: MigrationData = {
    tables: [
      {
        name: "memories",
        columns: [
          {
            name: "id",
            type: "integer",
            nullable: false,
            defaultValue: null
          }
        ]
      }
    ],
    indexes: [],
    rowCounts: {
      memories: 1
    }
  };
  const tool = new MigrationTool();

  const passingResult = tool.validateMigration(source, passingTarget);
  const failingResult = tool.validateMigration(source, failingTarget);

  assert.equal(passingResult.valid, true);
  assert.deepEqual(passingResult.errors, []);
  assert.equal(failingResult.valid, false);
  assert.match(failingResult.errors.join("\n"), /Column mismatch: memories.id/);
  assert.match(failingResult.errors.join("\n"), /Column mismatch: memories.content/);
  assert.match(failingResult.errors.join("\n"), /Missing index: memories_content_idx/);
  assert.match(failingResult.errors.join("\n"), /Row count mismatch: memories/);
});

test("migrate-db CLI parses options and writes generated SQL", () => {
  const { tempDir, dbPath } = createSqliteDatabase("vega-migration-cli-", (database) => {
    database.exec(`
      CREATE TABLE docs (
        id INTEGER NOT NULL,
        title TEXT
      );
    `);
  });
  const outputPath = join(tempDir, "migration.sql");

  try {
    const output = runCli(
      [
        "migrate-db",
        "--from",
        "sqlite",
        "--to",
        "postgres",
        "--source",
        dbPath,
        "--output",
        outputPath
      ],
      {
        VEGA_DB_PATH: ":memory:",
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );
    const generated = readFileSync(outputPath, "utf8");

    assert.equal(existsSync(outputPath), true);
    assert.match(output, /wrote 1 statements to/);
    assert.match(generated, /CREATE TABLE IF NOT EXISTS "docs"/);
    assert.match(generated, /"id" bigint NOT NULL/);
    assert.match(generated, /"title" text/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
