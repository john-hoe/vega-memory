import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { createAdapter } from "../db/adapter-factory.js";
import { PostgresAdapter, POSTGRES_STUB_ERROR } from "../db/postgres-adapter.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  dbEncryption: false,
  databaseType: "sqlite",
  embeddingProvider: "ollama",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: ":memory:",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  slackWebhookUrl: undefined,
  slackBotToken: undefined,
  slackChannel: undefined,
  slackEnabled: false,
  stripeSecretKey: undefined,
  stripeWebhookSecret: undefined,
  stripePublishableKey: undefined,
  stripeEnabled: false,
  oidcIssuerUrl: undefined,
  oidcClientId: undefined,
  oidcClientSecret: undefined,
  oidcCallbackUrl: undefined,
  redisUrl: undefined,
  redisHost: undefined,
  redisPort: undefined,
  redisPassword: undefined,
  redisDb: undefined,
  redisEnabled: false,
  pgHost: undefined,
  pgPort: undefined,
  pgDatabase: undefined,
  pgUser: undefined,
  pgPassword: undefined,
  pgSsl: undefined,
  pgSchema: undefined,
  cloudBackup: undefined,
  customRedactionPatterns: []
};

test("SQLiteAdapter supports CRUD, prepared statements, and transactions", () => {
  const adapter = new SQLiteAdapter(":memory:");

  try {
    adapter.exec("CREATE TABLE adapter_items (id TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    adapter.run("INSERT INTO adapter_items (id, value) VALUES (?, ?)", "alpha", 1);

    const insert = adapter.prepare<[string, number], never>(
      "INSERT INTO adapter_items (id, value) VALUES (?, ?)"
    );
    insert.run("beta", 2);

    const getItem = adapter.prepare<[string], { id: string; value: number }>(
      "SELECT id, value FROM adapter_items WHERE id = ?"
    );
    assert.deepEqual(getItem.get("beta"), { id: "beta", value: 2 });

    adapter.transaction(() => {
      adapter.run("UPDATE adapter_items SET value = value + 10 WHERE id = ?", "alpha");
    });

    assert.deepEqual(
      adapter.all<{ id: string; value: number }>(
        "SELECT id, value FROM adapter_items ORDER BY id ASC"
      ),
      [
        { id: "alpha", value: 11 },
        { id: "beta", value: 2 }
      ]
    );
  } finally {
    adapter.close();
  }
});

test("createAdapter defaults to SQLiteAdapter", () => {
  const adapter = createAdapter(baseConfig);

  try {
    assert.equal(adapter.isPostgres, false);
    assert.ok(adapter instanceof SQLiteAdapter);
  } finally {
    adapter.close();
  }
});

test("PostgresAdapter stub throws the documented error", () => {
  const adapter = new PostgresAdapter({
    host: "localhost",
    port: 5432,
    database: "vega",
    user: "vega",
    password: "secret",
    ssl: true,
    schema: "memory"
  });

  assert.equal(adapter.isPostgres, true);
  assert.throws(
    () => adapter.exec("SELECT 1"),
    (error: unknown) => error instanceof Error && error.message === POSTGRES_STUB_ERROR
  );
});
