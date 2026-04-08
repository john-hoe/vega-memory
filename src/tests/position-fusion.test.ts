import assert from "node:assert/strict";
import test from "node:test";

import { PositionAwareFusion } from "../search/position-fusion.js";

const approximatelyEqual = (actual: number, expected: number): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to equal ${expected}`);
};

test("PositionAwareFusion favors retrieval scores in top positions", () => {
  const fusion = new PositionAwareFusion({ enabled: true });
  const results = fusion.fuse([
    {
      id: "alpha",
      retrievalScore: 0.9,
      retrievalRank: 1,
      rerankerScore: 0.2,
      rerankerRank: 3
    },
    {
      id: "beta",
      retrievalScore: 0.75,
      retrievalRank: 3,
      rerankerScore: 0.1,
      rerankerRank: 5
    }
  ]);

  assert.deepEqual(
    results.map((result) => result.id),
    ["alpha", "beta"]
  );
  approximatelyEqual(results[0]?.retrievalWeight ?? 0, 0.7);
  approximatelyEqual(results[0]?.rerankerWeight ?? 0, 0.3);
  approximatelyEqual(results[0]?.finalScore ?? 0, 0.69);
  approximatelyEqual(results[1]?.retrievalWeight ?? 0, 0.7);
  approximatelyEqual(results[1]?.rerankerWeight ?? 0, 0.3);
  approximatelyEqual(results[1]?.finalScore ?? 0, 0.555);
});

test("PositionAwareFusion interpolates weights in middle positions", () => {
  const fusion = new PositionAwareFusion({ enabled: true });
  const [result] = fusion.fuse([
    {
      id: "middle",
      retrievalScore: 0.8,
      retrievalRank: 7,
      rerankerScore: 0.4,
      rerankerRank: 2
    }
  ]);

  assert.ok(result);
  approximatelyEqual(result.retrievalWeight, 0.5);
  approximatelyEqual(result.rerankerWeight, 0.5);
  approximatelyEqual(result.finalScore, 0.6);
  assert.equal(result.finalRank, 1);
});

test("PositionAwareFusion favors reranker scores in bottom positions", () => {
  const fusion = new PositionAwareFusion({ enabled: true });
  const results = fusion.fuse([
    {
      id: "late-reranked",
      retrievalScore: 0.2,
      retrievalRank: 11,
      rerankerScore: 1,
      rerankerRank: 1
    },
    {
      id: "late-retrieval",
      retrievalScore: 0.75,
      retrievalRank: 12,
      rerankerScore: 0.1,
      rerankerRank: 8
    }
  ]);

  assert.deepEqual(
    results.map((result) => result.id),
    ["late-reranked", "late-retrieval"]
  );
  approximatelyEqual(results[0]?.retrievalWeight ?? 0, 0.3);
  approximatelyEqual(results[0]?.rerankerWeight ?? 0, 0.7);
  approximatelyEqual(results[0]?.finalScore ?? 0, 0.76);
  approximatelyEqual(results[1]?.retrievalWeight ?? 0, 0.3);
  approximatelyEqual(results[1]?.rerankerWeight ?? 0, 0.7);
  approximatelyEqual(results[1]?.finalScore ?? 0, 0.295);
  assert.deepEqual(
    results.map((result) => result.finalRank),
    [1, 2]
  );
});

test("PositionAwareFusion disabled mode preserves retrieval order", () => {
  const fusion = new PositionAwareFusion({ enabled: false });
  const results = fusion.fuse([
    {
      id: "second",
      retrievalScore: 0.4,
      retrievalRank: 2,
      rerankerScore: 0.99,
      rerankerRank: 1
    },
    {
      id: "first",
      retrievalScore: 0.8,
      retrievalRank: 1,
      rerankerScore: 0.01,
      rerankerRank: 2
    }
  ]);

  assert.deepEqual(
    results.map((result) => result.id),
    ["first", "second"]
  );
  assert.deepEqual(
    results.map((result) => result.finalScore),
    [0.8, 0.4]
  );
  assert.deepEqual(
    results.map((result) => [result.retrievalWeight, result.rerankerWeight]),
    [[1, 0], [1, 0]]
  );
});

test("PositionAwareFusion handles empty input", () => {
  const fusion = new PositionAwareFusion({ enabled: true });

  assert.deepEqual(fusion.fuse([]), []);
});

test("PositionAwareFusion handles a single result", () => {
  const fusion = new PositionAwareFusion({ enabled: true });
  const [result] = fusion.fuse([
    {
      id: "solo",
      retrievalScore: 0.6,
      retrievalRank: 1,
      rerankerScore: 0.9,
      rerankerRank: 1
    }
  ]);

  assert.ok(result);
  approximatelyEqual(result.retrievalWeight, 0.7);
  approximatelyEqual(result.rerankerWeight, 0.3);
  approximatelyEqual(result.finalScore, 0.69);
  assert.equal(result.finalRank, 1);
});
