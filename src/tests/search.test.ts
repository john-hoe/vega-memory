import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import type { Memory, SearchOptions } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { BruteForceEngine } from "../search/brute-force.js";
import { SearchEngine } from "../search/engine.js";
import {
  computeFinalScore,
  computeRecency,
  getDecayRate,
  hybridSearch
} from "../search/ranking.js";

const createMemory = (overrides: Partial<Memory> = {}): Memory => ({
  id: "memory-1",
  type: "insight",
  project: "vega",
  title: "Memory",
  content: "Content",
  embedding: null,
  importance: 0.8,
  source: "explicit",
  tags: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  accessed_at: "2026-01-01T00:00:00.000Z",
  access_count: 0,
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: [],
  ...overrides
});

const createEmbeddingBuffer = (values: number[]): Buffer => Buffer.from(new Float32Array(values).buffer);

const defaultSearchOptions: SearchOptions = {
  limit: 10,
  minSimilarity: 0
};

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined
};

test("BruteForceEngine returns results sorted by similarity", () => {
  const engine = new BruteForceEngine();
  const queryEmbedding = new Float32Array([1, 0]);
  const memories = [
    {
      id: "exact",
      embedding: createEmbeddingBuffer([1, 0]),
      memory: createMemory({ id: "exact", title: "Exact" })
    },
    {
      id: "angled",
      embedding: createEmbeddingBuffer([0.8, 0.6]),
      memory: createMemory({ id: "angled", title: "Angled" })
    },
    {
      id: "opposite",
      embedding: createEmbeddingBuffer([-1, 0]),
      memory: createMemory({ id: "opposite", title: "Opposite" })
    }
  ];

  const results = engine.search(queryEmbedding, memories, { ...defaultSearchOptions, minSimilarity: -1 });

  assert.deepEqual(
    results.map((result) => result.memory.id),
    ["exact", "angled", "opposite"]
  );
  assert.equal(results[0]?.similarity, 1);
  assert.ok((results[1]?.similarity ?? 0) > (results[2]?.similarity ?? 0));
});

test("BruteForceEngine filters by minSimilarity", () => {
  const engine = new BruteForceEngine();
  const queryEmbedding = new Float32Array([1, 0]);
  const memories = [
    {
      id: "keep",
      embedding: createEmbeddingBuffer([1, 0]),
      memory: createMemory({ id: "keep" })
    },
    {
      id: "drop",
      embedding: createEmbeddingBuffer([0, 1]),
      memory: createMemory({ id: "drop" })
    }
  ];

  const results = engine.search(queryEmbedding, memories, { ...defaultSearchOptions, minSimilarity: 0.5 });

  assert.deepEqual(
    results.map((result) => result.memory.id),
    ["keep"]
  );
});

test("computeRecency returns 1.0 for just-accessed memory", () => {
  const now = Date.UTC(2026, 3, 3, 0, 0, 0);
  const originalNow = Date.now;
  Date.now = () => now;

  try {
    const recency = computeRecency(new Date(now).toISOString(), 0.3);

    assert.equal(recency, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("computeRecency returns lower value for old memory", () => {
  const now = Date.UTC(2026, 3, 3, 0, 0, 0);
  const originalNow = Date.now;
  Date.now = () => now;

  try {
    const recency = computeRecency("2026-03-24T00:00:00.000Z", 0.1);

    assert.equal(recency, 0.5);
  } finally {
    Date.now = originalNow;
  }
});

test("getDecayRate returns 0 for preference", () => {
  assert.equal(getDecayRate("preference"), 0);
});

test("computeFinalScore applies verified weight correctly", () => {
  const verifiedScore = computeFinalScore(0.8, 0.6, 0.4, "verified");
  const unverifiedScore = computeFinalScore(0.8, 0.6, 0.4, "unverified");

  assert.equal(unverifiedScore, verifiedScore * 0.7);
});

test("computeFinalScore excludes rejected", () => {
  const rejectedScore = computeFinalScore(0.8, 0.6, 0.4, "rejected");

  assert.equal(rejectedScore, 0);
});

test("hybridSearch merges vector and BM25 results with 70/30 weighting", () => {
  const sharedMemory = createMemory({ id: "shared" });
  const vectorOnlyMemory = createMemory({ id: "vector-only" });
  const bm25OnlyMemory = createMemory({ id: "bm25-only" });

  const results = hybridSearch(
    [
      { memory: sharedMemory, similarity: 0.9, finalScore: 0 },
      { memory: vectorOnlyMemory, similarity: 0.8, finalScore: 0 }
    ],
    [
      { memory: sharedMemory, rank: 0.05 },
      { memory: bm25OnlyMemory, rank: 0.2 }
    ]
  );

  assert.deepEqual(
    results.map((result) => result.memory.id),
    ["shared", "vector-only", "bm25-only"]
  );
  assert.equal(results[0]?.similarity, 1);
  assert.equal(results[1]?.similarity, 0.35);
  assert.equal(results[2]?.similarity, 0.15);
  assert.ok((results[0]?.finalScore ?? 0) > (results[1]?.finalScore ?? 0));
});

test("hybridSearch handles disjoint result sets", () => {
  const vectorMemory = createMemory({ id: "vector" });
  const bm25Memory = createMemory({ id: "bm25" });

  const results = hybridSearch(
    [{ memory: vectorMemory, similarity: 0.6, finalScore: 0 }],
    [{ memory: bm25Memory, rank: 0.1 }]
  );

  assert.deepEqual(
    results.map((result) => result.memory.id).sort(),
    ["bm25", "vector"]
  );
});

test("SearchEngine preserves BM25 boost inside hybrid search", () => {
  const repository = new Repository(":memory:");
  const engine = new SearchEngine(repository, baseConfig);
  const sharedTimestamp = "2026-04-03T00:00:00.000Z";

  try {
    repository.createMemory(
      createMemory({
        id: "vector-1",
        title: "Vector One",
        content: "Semantic match one",
        embedding: createEmbeddingBuffer([1, 0]),
        created_at: sharedTimestamp,
        updated_at: sharedTimestamp,
        accessed_at: sharedTimestamp
      })
    );
    repository.createMemory(
      createMemory({
        id: "vector-2",
        title: "Vector Two",
        content: "Semantic match two",
        embedding: createEmbeddingBuffer([0.8, 0.6]),
        created_at: sharedTimestamp,
        updated_at: sharedTimestamp,
        accessed_at: sharedTimestamp
      })
    );
    repository.createMemory(
      createMemory({
        id: "vector-3",
        title: "Vector Three",
        content: "Semantic match three",
        embedding: createEmbeddingBuffer([0.6, 0.8]),
        created_at: sharedTimestamp,
        updated_at: sharedTimestamp,
        accessed_at: sharedTimestamp
      })
    );
    repository.createMemory(
      createMemory({
        id: "bm25-keyword",
        title: "BM25 Keyword",
        content: "keyword keyword keyword exact keyword match",
        embedding: null,
        created_at: sharedTimestamp,
        updated_at: sharedTimestamp,
        accessed_at: sharedTimestamp
      })
    );

    const results = engine.search("keyword", new Float32Array([1, 0]), {
      ...defaultSearchOptions,
      minSimilarity: 0.1
    });

    assert.deepEqual(
      results.map((result) => result.memory.id),
      ["vector-1", "vector-2", "bm25-keyword", "vector-3"]
    );
    assert.ok((results[2]?.similarity ?? 0) > (results[3]?.similarity ?? 0));
  } finally {
    repository.close();
  }
});

test("SearchEngine excludes archived memories from recall results", () => {
  const repository = new Repository(":memory:");
  const engine = new SearchEngine(repository, baseConfig);
  const sharedEmbedding = createEmbeddingBuffer([1, 0]);

  try {
    repository.createMemory(
      createMemory({
        id: "active-match",
        title: "Active match",
        content: "keyword stays searchable",
        embedding: sharedEmbedding,
        status: "active"
      })
    );
    repository.createMemory(
      createMemory({
        id: "archived-match",
        title: "Archived match",
        content: "keyword should stay hidden",
        embedding: sharedEmbedding,
        status: "archived"
      })
    );

    const results = engine.search("keyword", new Float32Array([1, 0]), {
      ...defaultSearchOptions,
      minSimilarity: 0.1
    });

    assert.deepEqual(
      results.map((result) => result.memory.id),
      ["active-match"]
    );
  } finally {
    repository.close();
  }
});
