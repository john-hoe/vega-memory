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
  const originalFetch = global.fetch;

  global.fetch = async () =>
    new Response(null, {
      status: 500
    });

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

    assert.deepEqual(
      results.map((result) => result.id),
      ["best", "next", "last"]
    );
    assert.equal(results[0]?.rerankerScore, 1);
    assert.equal(results[1]?.rerankerScore, 0.5);
    assert.equal(results[2]?.rerankerScore, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rerankWithModel uses remote scores when Ollama returns valid JSON", async () => {
  const reranker = new Reranker({ enabled: true, model: "bge-reranker-v2-m3" });
  const originalFetch = global.fetch;
  let bodyText = "";

  global.fetch = async (_input, init) => {
    bodyText = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            scores: [0.1, 0.9, 0.4]
          })
        }
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };

  try {
    const results = await reranker.rerankWithModel(
      "beta gamma",
      [
        createCandidate({ id: "best", title: "Gamma", content: "beta gamma", originalRank: 1 }),
        createCandidate({ id: "next", title: "Strong", content: "gamma", originalRank: 2 }),
        createCandidate({ id: "last", title: "Weak", content: "alpha", originalRank: 3 })
      ],
      "bge-reranker-v2-m3",
      "http://localhost:11434"
    );

    assert.match(bodyText, /Gamma\\\\nbeta gamma/);
    assert.deepEqual(
      results.map((result) => result.id),
      ["next", "last", "best"]
    );
    assert.equal(results[0]?.rerankerScore, 1);
    assert.ok(Math.abs((results[1]?.rerankerScore ?? 0) - 0.375) < 1e-9);
    assert.equal(results[2]?.rerankerScore, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
