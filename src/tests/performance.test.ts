import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { ShardManager } from "../db/shard.js";
import { EmbeddingCache } from "../embedding/cache.js";
import { StreamingSearch } from "../search/streaming.js";
import { RelevanceTuner } from "../search/tuning.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
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
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
};

const createEmbeddingBuffer = (values: number[]): Buffer =>
  Buffer.from(new Float32Array(values).buffer);

const createMemory = (id: string, overrides: Partial<Memory> = {}): Memory => ({
  id,
  type: "decision",
  project: "vega",
  title: id,
  content: `content for ${id}`,
  embedding: createEmbeddingBuffer([1, 0]),
  importance: 0.8,
  source: "explicit",
  tags: [],
  created_at: "2026-04-05T00:00:00.000Z",
  updated_at: "2026-04-05T00:00:00.000Z",
  accessed_at: "2026-04-05T00:00:00.000Z",
  access_count: 0,
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

test("EmbeddingCache supports get, set, and LRU eviction", () => {
  const cache = new EmbeddingCache(2);

  cache.set("alpha", new Float32Array([1, 2]));
  cache.set("beta", new Float32Array([3, 4]));
  assert.deepEqual(Array.from(cache.get("alpha") ?? []), [1, 2]);

  cache.set("gamma", new Float32Array([5, 6]));

  assert.equal(cache.get("beta"), undefined);
  assert.deepEqual(Array.from(cache.get("alpha") ?? []), [1, 2]);
  assert.deepEqual(Array.from(cache.get("gamma") ?? []), [5, 6]);
  assert.equal(cache.size(), 2);
});

test("EmbeddingCache.hitRate tracks hits and misses", () => {
  const cache = new EmbeddingCache();

  assert.equal(cache.get("missing"), undefined);
  cache.set("alpha", new Float32Array([1]));
  assert.deepEqual(Array.from(cache.get("alpha") ?? []), [1]);
  assert.equal(cache.get("missing-again"), undefined);

  const stats = cache.hitRate();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 2);
  assert.equal(stats.rate, 1 / 3);
});

test("ShardManager.getShardPath returns the shard file path", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-shards-path-"));
  const shardManager = new ShardManager(tempDir);

  try {
    assert.equal(shardManager.getShardPath("project-a"), join(tempDir, "shards", "project-a.db"));
  } finally {
    shardManager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ShardManager.getOrCreateShard creates and caches shard repositories", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-shards-create-"));
  const shardManager = new ShardManager(tempDir);

  try {
    const repository = shardManager.getOrCreateShard("alpha");
    const cachedRepository = shardManager.getOrCreateShard("alpha");

    assert.ok(existsSync(shardManager.getShardPath("alpha")));
    assert.equal(repository, cachedRepository);
  } finally {
    shardManager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ShardManager.listShards returns shard file names", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-shards-list-"));
  const shardManager = new ShardManager(tempDir);

  try {
    shardManager.getOrCreateShard("alpha");
    shardManager.getOrCreateShard("beta");

    assert.deepEqual(shardManager.listShards(), ["alpha.db", "beta.db"]);
  } finally {
    shardManager.closeAll();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("StreamingSearch yields results progressively", async () => {
  const repository = new Repository(":memory:");
  const streamingSearch = new StreamingSearch(repository, baseConfig);

  try {
    repository.createMemory(
      createMemory("exact-match", {
        embedding: createEmbeddingBuffer([1, 0]),
        updated_at: "2026-04-05T12:00:00.000Z",
        accessed_at: "2026-04-05T12:00:00.000Z"
      })
    );

    for (let index = 0; index < 149; index += 1) {
      repository.createMemory(
        createMemory(`memory-${index}`, {
          embedding: createEmbeddingBuffer([0.4, 0.6]),
          updated_at: `2026-04-04T${String(index % 10).padStart(2, "0")}:00:00.000Z`,
          accessed_at: "2026-04-04T00:00:00.000Z"
        })
      );
    }

    const iterator = streamingSearch.searchStream(
      "semantic query",
      new Float32Array([1, 0]),
      {
        project: "vega",
        limit: 3,
        minSimilarity: 0
      }
    );
    const first = await iterator.next();

    assert.equal(first.done, false);
    assert.equal(first.value?.memory.id, "exact-match");
    await iterator.return(undefined);
  } finally {
    repository.close();
  }
});

test("RelevanceTuner.analyzeSearchQuality returns a populated report", () => {
  const repository = new Repository(":memory:");
  const tuner = new RelevanceTuner(repository);

  try {
    repository.logPerformance({
      timestamp: "2026-04-05T00:00:00.000Z",
      operation: "recall",
      latency_ms: 50,
      memory_count: 10,
      result_count: 2,
      avg_similarity: 0.72,
      result_types: ["decision", "insight"],
      bm25_result_count: 1
    });
    repository.logPerformance({
      timestamp: "2026-04-05T00:01:00.000Z",
      operation: "recall",
      latency_ms: 75,
      memory_count: 10,
      result_count: 0,
      avg_similarity: null,
      result_types: [],
      bm25_result_count: 0
    });
    repository.logPerformance({
      timestamp: "2026-04-05T00:02:00.000Z",
      operation: "recall_stream",
      latency_ms: 60,
      memory_count: 10,
      result_count: 1,
      avg_similarity: 0.61,
      result_types: ["decision"],
      bm25_result_count: 0
    });

    const report = tuner.analyzeSearchQuality();

    assert.equal(report.avg_latency_ms, 61.667);
    assert.equal(report.avg_results, 1);
    assert.equal(report.zero_result_pct, 33.333);
    assert.equal(report.type_distribution.decision, 2);
    assert.equal(report.type_distribution.insight, 1);
    assert.ok(report.recommendations.length > 0);
  } finally {
    repository.close();
  }
});
