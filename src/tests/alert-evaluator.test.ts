import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAlertRules, type AlertRule } from "../alert/index.js";

const baseRule: AlertRule = {
  id: "rule",
  severity: "warn",
  metric: "vega_metric",
  operator: ">",
  threshold: 10,
  window_ms: 60_000,
  min_duration_ms: 0,
  channels: ["default_webhook"]
};

test("evaluateAlertRules returns firing when a threshold is crossed and the min duration is met", async () => {
  const evaluations = await evaluateAlertRules([baseRule], {
    metricsQuery: async () => 11,
    now: () => new Date("2026-04-20T00:00:00.000Z")
  });

  assert.equal(evaluations[0]?.state, "firing");
  assert.deepEqual(evaluations[0]?.reasons, ["threshold_crossed"]);
});

test("evaluateAlertRules returns pending when a threshold is crossed but the min duration exceeds the window", async () => {
  const evaluations = await evaluateAlertRules(
    [
      {
        ...baseRule,
        min_duration_ms: 120_000
      }
    ],
    {
      metricsQuery: async () => 11,
      now: () => new Date("2026-04-20T00:00:00.000Z")
    }
  );

  assert.equal(evaluations[0]?.state, "pending");
  assert.deepEqual(evaluations[0]?.reasons, ["threshold_crossed", "min_duration_not_met"]);
});

test("evaluateAlertRules returns resolved when a threshold is not crossed", async () => {
  const evaluations = await evaluateAlertRules([baseRule], {
    metricsQuery: async () => 4,
    now: () => new Date("2026-04-20T00:00:00.000Z")
  });

  assert.equal(evaluations[0]?.state, "resolved");
  assert.deepEqual(evaluations[0]?.reasons, ["threshold_not_crossed"]);
});

test("evaluateAlertRules returns skipped when a metric is unavailable", async () => {
  const evaluations = await evaluateAlertRules([baseRule], {
    metricsQuery: async () => null,
    now: () => new Date("2026-04-20T00:00:00.000Z")
  });

  assert.equal(evaluations[0]?.state, "skipped");
  assert.deepEqual(evaluations[0]?.reasons, ["metric_unavailable"]);
});

test("evaluateAlertRules supports the greater-than operator", async () => {
  const evaluations = await evaluateAlertRules([baseRule], {
    metricsQuery: async () => 10,
    now: () => new Date("2026-04-20T00:00:00.000Z")
  });

  assert.equal(evaluations[0]?.state, "resolved");
});

test("evaluateAlertRules supports the less-than operator", async () => {
  const evaluations = await evaluateAlertRules(
    [
      {
        ...baseRule,
        operator: "<",
        threshold: 5
      }
    ],
    {
      metricsQuery: async () => 4,
      now: () => new Date("2026-04-20T00:00:00.000Z")
    }
  );

  assert.equal(evaluations[0]?.state, "firing");
});

test("evaluateAlertRules supports the greater-than-or-equal and less-than-or-equal operators", async () => {
  const greaterThanOrEqual = await evaluateAlertRules(
    [
      {
        ...baseRule,
        operator: ">=",
        threshold: 5
      }
    ],
    {
      metricsQuery: async () => 5,
      now: () => new Date("2026-04-20T00:00:00.000Z")
    }
  );
  const lessThanOrEqual = await evaluateAlertRules(
    [
      {
        ...baseRule,
        operator: "<=",
        threshold: 5
      }
    ],
    {
      metricsQuery: async () => 5,
      now: () => new Date("2026-04-20T00:00:00.000Z")
    }
  );

  assert.equal(greaterThanOrEqual[0]?.state, "firing");
  assert.equal(lessThanOrEqual[0]?.state, "firing");
});
