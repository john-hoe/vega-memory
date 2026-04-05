import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";
import { SqliteVecEngine } from "../search/sqlite-vec.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  cloudBackup: undefined
};

const createEmbeddingBuffer = (values: number[]): Buffer => Buffer.from(new Float32Array(values).buffer);

const createMemory = (overrides: Partial<Memory> = {}): Memory => ({
  id: "memory-1",
  type: "decision",
  project: "vega",
  title: "Memory",
  content: "Content",
  embedding: createEmbeddingBuffer([1, 0]),
  importance: 0.8,
  source: "explicit",
  tags: [],
  created_at: "2026-04-04T00:00:00.000Z",
  updated_at: "2026-04-04T00:00:00.000Z",
  accessed_at: "2026-04-04T00:00:00.000Z",
  access_count: 0,
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const forceMissingExtension = (repository: Repository): (() => void) => {
  const database = repository.db as unknown as { loadExtension: (path: string) => unknown };
  const originalLoadExtension = database.loadExtension;

  database.loadExtension = (_path: string) => {
    throw new Error("sqlite-vec missing");
  };

  return () => {
    database.loadExtension = originalLoadExtension;
  };
};

test("SqliteVecEngine.isAvailable returns false when extension not installed", () => {
  const repository = new Repository(":memory:");
  const restoreLoadExtension = forceMissingExtension(repository);
  const engine = new SqliteVecEngine(repository);

  try {
    assert.equal(engine.isAvailable(), false);
  } finally {
    restoreLoadExtension();
    repository.close();
  }
});

test("SearchEngine falls back to BruteForceEngine when sqlite-vec unavailable", () => {
  const repository = new Repository(":memory:");
  const restoreLoadExtension = forceMissingExtension(repository);
  const messages: string[] = [];
  const originalLog = console.log;

  console.log = (...values: unknown[]) => {
    messages.push(values.map((value) => String(value)).join(" "));
  };

  try {
    repository.createMemory(createMemory());

    const engine = new SearchEngine(repository, baseConfig);
    const results = engine.search("Memory", new Float32Array([1, 0]), {
      limit: 5,
      minSimilarity: 0
    });

    assert.match(messages.join("\n"), /Vector search engine: brute-force/);
    assert.deepEqual(
      results.map((result) => result.memory.id),
      ["memory-1"]
    );
  } finally {
    console.log = originalLog;
    restoreLoadExtension();
    repository.close();
  }
});
