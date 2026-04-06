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
  shardingEnabled: false,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  dbEncryption: false,
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
  const originalWrite = process.stderr.write.bind(process.stderr);

  process.stderr.write = ((chunk: string | Uint8Array) => {
    messages.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

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
    process.stderr.write = originalWrite;
    restoreLoadExtension();
    repository.close();
  }
});

test("SqliteVecEngine.createIndex keeps the dominant embedding dimension", () => {
  const vectors = [
    createEmbeddingBuffer([1, 0, 0]),
    createEmbeddingBuffer([1, 0]),
    createEmbeddingBuffer([0.8, 0.2])
  ];
  const insertedEmbeddings: string[] = [];
  const repository = {
    db: {
      loadExtension: () => undefined,
      exec: () => undefined,
      prepare: () => ({
        run: (_rowid: number, embedding: string) => {
          insertedEmbeddings.push(embedding);
        }
      }),
      transaction: (callback: () => void) => () => callback()
    },
    getEmbeddingIndexSnapshot: () => ({
      count: vectors.length,
      latestUpdatedAt: "2026-04-05T00:00:00.000Z",
      totalBytes: vectors.reduce((sum, vector) => sum + vector.byteLength, 0)
    }),
    getAllEmbeddings: () =>
      vectors.map((embedding, index) => ({
        id: `memory-${index + 1}`,
        embedding,
        memory: createMemory({
          id: `memory-${index + 1}`,
          embedding
        })
      }))
  } as unknown as Repository;
  const engine = new SqliteVecEngine(repository);
  const state = engine as unknown as {
    availabilityChecked: boolean;
    available: boolean;
    indexDimension: number | null;
  };

  state.availabilityChecked = true;
  state.available = true;

  assert.equal(engine.createIndex(), 2);
  assert.equal(state.indexDimension, 2);
  assert.equal(insertedEmbeddings.length, 2);
});

test("SqliteVecEngine.search continues scanning batches until scoped matches are found", () => {
  const rowids = Array.from({ length: 40 }, (_, index) => ({
    rowid: index + 1,
    distance: index
  }));
  const repository = {
    db: {
      loadExtension: () => undefined,
      prepare: () => ({
        all: (_query: string, limit: number, offset: number) => rowids.slice(offset, offset + limit)
      })
    }
  } as unknown as Repository;
  const engine = new SqliteVecEngine(repository);
  const state = engine as unknown as {
    availabilityChecked: boolean;
    available: boolean;
    createIndex: () => number;
    indexDimension: number | null;
    indexedCount: number;
    indexedCandidates: Array<{
      id: string;
      memory: Memory;
      vector: Float32Array;
    }>;
  };

  state.availabilityChecked = true;
  state.available = true;
  state.createIndex = () => 40;
  state.indexDimension = 2;
  state.indexedCount = 40;
  state.indexedCandidates = Array.from({ length: 40 }, (_, index) => ({
    id: `memory-${index + 1}`,
    memory: createMemory({
      id: `memory-${index + 1}`,
      project: index === 39 ? "vega" : "other"
    }),
    vector: new Float32Array([1, 0])
  }));

  const results = engine.search(new Float32Array([1, 0]), {
    project: "vega",
    limit: 1,
    minSimilarity: 0
  });

  assert.deepEqual(
    results.map((result) => result.memory.id),
    ["memory-40"]
  );
});
