import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TIMEOUT_SWEEP_INTERVAL_MS,
  DEFAULT_TIMEOUT_SWEEP_MAX_PER_RUN,
  resolveTimeoutSweepConfig
} from "../timeout/config.js";

test("resolveTimeoutSweepConfig returns documented defaults", () => {
  assert.deepEqual(resolveTimeoutSweepConfig({}), {
    intervalMs: DEFAULT_TIMEOUT_SWEEP_INTERVAL_MS,
    maxPerRun: DEFAULT_TIMEOUT_SWEEP_MAX_PER_RUN,
    enabled: true
  });
});

test("resolveTimeoutSweepConfig accepts positive env overrides", () => {
  assert.deepEqual(
    resolveTimeoutSweepConfig({
      VEGA_TIMEOUT_SWEEP_INTERVAL_MS: "15000",
      VEGA_TIMEOUT_SWEEP_MAX_PER_RUN: "25"
    }),
    {
      intervalMs: 15_000,
      maxPerRun: 25,
      enabled: true
    }
  );
});

test("resolveTimeoutSweepConfig falls back for non-positive env overrides", () => {
  assert.deepEqual(
    resolveTimeoutSweepConfig({
      VEGA_TIMEOUT_SWEEP_INTERVAL_MS: "0",
      VEGA_TIMEOUT_SWEEP_MAX_PER_RUN: "-5"
    }),
    {
      intervalMs: DEFAULT_TIMEOUT_SWEEP_INTERVAL_MS,
      maxPerRun: DEFAULT_TIMEOUT_SWEEP_MAX_PER_RUN,
      enabled: true
    }
  );
});

test("resolveTimeoutSweepConfig disables only when VEGA_TIMEOUT_SWEEP_ENABLED is false", () => {
  assert.equal(
    resolveTimeoutSweepConfig({
      VEGA_TIMEOUT_SWEEP_ENABLED: "false"
    }).enabled,
    false
  );
  assert.equal(
    resolveTimeoutSweepConfig({
      VEGA_TIMEOUT_SWEEP_ENABLED: "0"
    }).enabled,
    true
  );
});
