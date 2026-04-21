import assert from "node:assert/strict";
import test from "node:test";

import { computeRecency } from "../retrieval/ranker-score.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-04-21T00:00:00.000Z");

test("computeRecency returns 1 for records created at the current time", () => {
  assert.equal(computeRecency(NOW, NOW), 1);
});

test("computeRecency decays to roughly 0.5 after seven days", () => {
  const score = computeRecency(NOW - 7 * DAY_MS, NOW);

  assert.ok(Math.abs(score - 0.5) < 0.01);
});

test("computeRecency decays to roughly 0.25 after fourteen days", () => {
  const score = computeRecency(NOW - 14 * DAY_MS, NOW);

  assert.ok(Math.abs(score - 0.25) < 0.01);
});

test("computeRecency stays above zero at seventy days", () => {
  assert.ok(computeRecency(NOW - 70 * DAY_MS, NOW) > 0);
});

test("computeRecency underflows to zero for truly ancient timestamps", () => {
  assert.equal(computeRecency(NOW - 20_000 * 365 * DAY_MS, NOW), 0);
});

test("computeRecency clamps future timestamps to one", () => {
  assert.equal(computeRecency(NOW + DAY_MS, NOW), 1);
});
