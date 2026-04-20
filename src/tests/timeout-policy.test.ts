import assert from "node:assert/strict";
import test from "node:test";

import { classifyTimeout, type DetectedTimeout } from "../timeout/policy.js";

const createDetectedTimeout = (
  overrides: Partial<DetectedTimeout> = {}
): DetectedTimeout => ({
  checkpoint_id: "checkpoint-1",
  created_at: 1_000,
  ttl_ms: 30_000,
  expires_at: 31_000,
  host_tier: "T1",
  surface: "codex",
  ...overrides
});

test("classifyTimeout maps T1 to presumed_sufficient", () => {
  assert.deepEqual(classifyTimeout(createDetectedTimeout({ host_tier: "T1" })), {
    decision: "presumed_sufficient",
    reason: "l1_ttl_expired_tier_t1"
  });
});

test("classifyTimeout maps T2 to presumed_sufficient", () => {
  assert.deepEqual(classifyTimeout(createDetectedTimeout({ host_tier: "T2" })), {
    decision: "presumed_sufficient",
    reason: "l1_ttl_expired_tier_t2"
  });
});

test("classifyTimeout maps T3 to hard_failure", () => {
  assert.deepEqual(classifyTimeout(createDetectedTimeout({ host_tier: "T3" })), {
    decision: "hard_failure",
    reason: "l1_ttl_expired_tier_t3"
  });
});

test("classifyTimeout maps unknown to hard_failure", () => {
  assert.deepEqual(classifyTimeout(createDetectedTimeout({ host_tier: "unknown" })), {
    decision: "hard_failure",
    reason: "l1_ttl_expired_tier_unknown"
  });
});
