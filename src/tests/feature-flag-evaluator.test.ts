import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFeatureFlag } from "../feature-flags/evaluator.js";
import type { FeatureFlag } from "../feature-flags/registry.js";

const baseFlag: FeatureFlag = {
  id: "canary-test",
  description: "Test",
  variants: { on: true, off: false },
  default: "off",
  matchers: {
    surfaces: "*",
    intents: "*",
    traffic_percent: 50
  }
};

test("evaluateFeatureFlag matcher hit returns the bucketed on variant below threshold", () => {
  const result = evaluateFeatureFlag(baseFlag, { surface: "codex", intent: "ingest", session_id: "stable" });
  assert.equal(result.variant, "on");
  assert.equal(result.reason, "bucket_20_50");
});

test("evaluateFeatureFlag matcher miss returns default", () => {
  const flag: FeatureFlag = {
    ...baseFlag,
    matchers: { surfaces: ["claude"], intents: "*", traffic_percent: 50 }
  };
  const result = evaluateFeatureFlag(flag, { surface: "codex", intent: "ingest" });
  assert.equal(result.variant, "off");
  assert.equal(result.reason, "matcher_miss");
});

test("evaluateFeatureFlag traffic 0 always off", () => {
  const flag: FeatureFlag = { ...baseFlag, matchers: { ...baseFlag.matchers, traffic_percent: 0 } };
  const result = evaluateFeatureFlag(flag, { surface: "codex", intent: "ingest", session_id: "s1" });
  assert.equal(result.variant, "off");
  assert.equal(result.reason, "traffic_0");
});

test("evaluateFeatureFlag traffic 100 always on", () => {
  const flag: FeatureFlag = { ...baseFlag, matchers: { ...baseFlag.matchers, traffic_percent: 100 } };
  const result = evaluateFeatureFlag(flag, { surface: "codex", intent: "ingest", session_id: "s1" });
  assert.equal(result.variant, "on");
  assert.equal(result.reason, "traffic_100");
});

test("evaluateFeatureFlag 50% traffic is stable for the same seed", () => {
  const result1 = evaluateFeatureFlag(baseFlag, { surface: "codex", intent: "ingest", session_id: "stable" });
  const result2 = evaluateFeatureFlag(baseFlag, { surface: "codex", intent: "ingest", session_id: "stable" });
  assert.deepEqual(result1, result2);
});

test("evaluateFeatureFlag 50% traffic returns off above threshold", () => {
  const result = evaluateFeatureFlag(baseFlag, { surface: "codex", intent: "ingest", session_id: "over" });
  assert.equal(result.variant, "off");
  assert.equal(result.reason, "bucket_75_50");
});

test("evaluateFeatureFlag seed_field override uses project", () => {
  const flag: FeatureFlag = {
    ...baseFlag,
    bucketing: { seed_field: "project" }
  };
  const result = evaluateFeatureFlag(flag, { surface: "codex", intent: "ingest", project: "p1" });
  assert.equal(result.variant, "on");
  assert.equal(result.reason, "bucket_10_50");
});
