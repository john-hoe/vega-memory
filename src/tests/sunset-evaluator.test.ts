import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSunsetCandidates, type SunsetCandidate } from "../sunset/evaluator.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";

const db = new SQLiteAdapter(":memory:");

function createCandidate(
  overrides: Partial<SunsetCandidate> = {},
  criteriaOverrides: Partial<SunsetCandidate["criteria"]> = {}
): SunsetCandidate {
  return {
    id: "legacy-store-route",
    type: "api_route",
    target: "POST /memory_store",
    deprecated_since: "2026-01-15",
    criteria: {
      time_based: {
        min_days_since_deprecated: 90
      },
      ...criteriaOverrides
    },
    notification: {
      changelog: true,
      log_level: "warn"
    },
    ...overrides
  };
}

test("evaluateSunsetCandidates marks time_based criteria as ready when days elapsed exceed threshold", async () => {
  const [result] = await evaluateSunsetCandidates(
    [createCandidate()],
    {
      db,
      now: new Date("2026-04-20T00:00:00.000Z"),
      metricsQuery: async () => null
    }
  );

  assert.equal(result?.status, "ready");
  assert.equal(result?.reasons.some((reason) => reason.includes("time_based: 95 days elapsed >= 90")), true);
});

test("evaluateSunsetCandidates keeps time_based criteria pending when days elapsed are below threshold", async () => {
  const [result] = await evaluateSunsetCandidates(
    [createCandidate({ deprecated_since: "2026-02-19" })],
    {
      db,
      now: new Date("2026-04-20T00:00:00.000Z"),
      metricsQuery: async () => null
    }
  );

  assert.equal(result?.status, "pending");
  assert.equal(result?.reasons.some((reason) => reason.includes("time_based: 60 days elapsed < 90")), true);
});

test("evaluateSunsetCandidates marks usage_threshold criteria as ready when observed calls are below threshold", async () => {
  const [result] = await evaluateSunsetCandidates(
    [
      createCandidate(
        {},
        {
          time_based: undefined,
          usage_threshold: {
            metric: "vega_calls_total",
            window_days: 30,
            max_calls: 10
          }
        }
      )
    ],
    {
      db,
      now: new Date("2026-04-20T00:00:00.000Z"),
      metricsQuery: async () => 2
    }
  );

  assert.equal(result?.status, "ready");
  assert.equal(result?.reasons.some((reason) => reason.includes("usage_threshold: 2 calls <= 10 over 30 days")), true);
});

test("evaluateSunsetCandidates keeps usage_threshold criteria pending when observed calls exceed threshold", async () => {
  const [result] = await evaluateSunsetCandidates(
    [
      createCandidate(
        {},
        {
          time_based: undefined,
          usage_threshold: {
            metric: "vega_calls_total",
            window_days: 30,
            max_calls: 10
          }
        }
      )
    ],
    {
      db,
      now: new Date("2026-04-20T00:00:00.000Z"),
      metricsQuery: async () => 50
    }
  );

  assert.equal(result?.status, "pending");
  assert.equal(result?.reasons.some((reason) => reason.includes("usage_threshold: 50 calls > 10 over 30 days")), true);
});

test("evaluateSunsetCandidates reports metric_unavailable when the metric query returns null", async () => {
  const [result] = await evaluateSunsetCandidates(
    [
      createCandidate(
        {},
        {
          time_based: undefined,
          usage_threshold: {
            metric: "vega_calls_total",
            window_days: 30,
            max_calls: 10
          }
        }
      )
    ],
    {
      db,
      now: new Date("2026-04-20T00:00:00.000Z"),
      metricsQuery: async () => null
    }
  );

  assert.equal(result?.status, "pending");
  assert.equal(result?.reasons.includes("metric_unavailable"), true);
});

test("evaluateSunsetCandidates uses OR logic when time_based is ready and usage_threshold is pending", async () => {
  const [result] = await evaluateSunsetCandidates(
    [
      createCandidate(
        {},
        {
          usage_threshold: {
            metric: "vega_calls_total",
            window_days: 30,
            max_calls: 10
          }
        }
      )
    ],
    {
      db,
      now: new Date("2026-04-20T00:00:00.000Z"),
      metricsQuery: async () => 50
    }
  );

  assert.equal(result?.status, "ready");
  assert.equal(result?.reasons.some((reason) => reason.includes("time_based: 95 days elapsed >= 90")), true);
  assert.equal(result?.reasons.some((reason) => reason.includes("usage_threshold: 50 calls > 10 over 30 days")), true);
});
