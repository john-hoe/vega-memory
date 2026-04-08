import assert from "node:assert/strict";
import test from "node:test";

import { Reranker, type RerankerCandidate } from "../search/reranker.js";

const createCandidate = (overrides: Partial<RerankerCandidate> = {}): RerankerCandidate => ({
  id: "candidate-1",
  content: "alpha beta gamma",
  originalScore: 0.5,
  originalRank: 1,
  ...overrides
});

test("rerank returns results sorted by reranker score", async () => {
  const reranker = new Reranker({ enabled: true });
  const results = await reranker.rerank("alpha beta", [
    createCandidate({ id: "best", content: "alpha beta gamma", originalRank: 3 }),
    createCandidate({ id: "middle", content: "alpha only", originalRank: 1 }),
    createCandidate({ id: "last", content: "gamma delta", originalRank: 2 })
  ]);

  assert.deepEqual(
    results.map((result) => result.id),
    ["best", "middle", "last"]
  );
  assert.deepEqual(
    results.map((result) => result.finalRank),
    [1, 2, 3]
  );
});

test("topK limits rerank results", async () => {
  const reranker = new Reranker({ enabled: true, topK: 2 });
  const results = await reranker.rerank("alpha beta", [
    createCandidate({ id: "first", content: "alpha beta" }),
    createCandidate({ id: "second", content: "alpha" }),
    createCandidate({ id: "third", content: "beta", originalRank: 3 })
  ]);

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => result.id),
    ["first", "second"]
  );
});

test("keyword overlap scoring normalizes matches by query term count", async () => {
  const reranker = new Reranker({ enabled: true });
  const results = await reranker.rerank("alpha beta gamma", [
    createCandidate({ id: "two-matches", content: "alpha gamma only" }),
    createCandidate({ id: "one-match", content: "beta only", originalRank: 2 }),
    createCandidate({ id: "repeat-match", content: "alpha alpha alpha", originalRank: 3 })
  ]);

  assert.equal(results[0]?.rerankerScore, 2 / 3);
  assert.equal(results[1]?.rerankerScore, 1 / 3);
  assert.equal(results[2]?.rerankerScore, 1 / 3);
  assert.deepEqual(
    results.map((result) => result.id),
    ["two-matches", "one-match", "repeat-match"]
  );
});

test("disabled mode returns candidates in original order", async () => {
  const reranker = new Reranker({ enabled: false });
  const input = [
    createCandidate({ id: "first", content: "none", originalScore: 0.2, originalRank: 2 }),
    createCandidate({ id: "second", content: "alpha beta", originalScore: 0.9, originalRank: 1 }),
    createCandidate({ id: "third", content: "alpha", originalScore: 0.4, originalRank: 3 })
  ];
  const results = await reranker.rerank("alpha beta", input);

  assert.deepEqual(
    results.map((result) => result.id),
    input.map((candidate) => candidate.id)
  );
  assert.deepEqual(
    results.map((result) => result.rerankerScore),
    input.map((candidate) => candidate.originalScore)
  );
});

test("rerankWithModel falls back to keyword scoring", async () => {
  const reranker = new Reranker({ enabled: true, model: "bge-reranker-v2-m3" });
  const originalConsoleLog = console.log;
  const messages: string[] = [];

  console.log = (message?: unknown, ...args: unknown[]): void => {
    messages.push([message, ...args].map((value) => String(value)).join(" "));
  };

  try {
    const results = await reranker.rerankWithModel(
      "beta gamma",
      [
        createCandidate({ id: "best", content: "beta gamma" }),
        createCandidate({ id: "next", content: "gamma", originalRank: 2 }),
        createCandidate({ id: "last", content: "alpha", originalRank: 3 })
      ],
      "bge-reranker-v2-m3",
      "http://localhost:11434"
    );

    assert.ok(messages.includes("Reranker model not connected"));
    assert.deepEqual(
      results.map((result) => result.id),
      ["best", "next", "last"]
    );
    assert.equal(results[0]?.rerankerScore, 1);
    assert.equal(results[1]?.rerankerScore, 0.5);
    assert.equal(results[2]?.rerankerScore, 0);
  } finally {
    console.log = originalConsoleLog;
  }
});
