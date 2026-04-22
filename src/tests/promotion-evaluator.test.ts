import assert from "node:assert/strict";
import test from "node:test";

import type { CandidateMemoryRecord } from "../db/candidate-repository.js";
import type { AckRecord, AckStore } from "../usage/ack-store.js";
import {
  createPromotionEvaluator
} from "../promotion/evaluator.js";
import {
  createDefaultPromotionPolicy,
  type PromotionContext,
  type PromotionDecision,
  type PromotionPolicy
} from "../promotion/policy.js";

const NOW = 9_000;

function createCandidate(
  overrides: Partial<CandidateMemoryRecord> = {}
): CandidateMemoryRecord {
  return {
    id: "candidate-1",
    content: "Candidate memory",
    type: "decision",
    project: "vega-memory",
    tags: ["wave-4"],
    metadata: {},
    extraction_source: "manual",
    extraction_confidence: 0.9,
    promotion_score: 0,
    visibility_gated: true,
    candidate_state: "pending",
    raw_dedup_key: null,
    semantic_fingerprint: null,
    created_at: NOW - 100,
    updated_at: NOW - 100,
    ...overrides
  };
}

function createAck(session_id: string): AckRecord {
  return {
    checkpoint_id: `${session_id}-checkpoint`,
    bundle_digest: `${session_id}-bundle`,
    sufficiency: "sufficient",
    host_tier: "T2",
    evidence: null,
    turn_elapsed_ms: null,
    session_id,
    acked_at: NOW - 10,
    guard_overridden: false
  };
}

test("evaluator passes candidate, trigger, and now through the configured policy", () => {
  const seen: PromotionContext[] = [];
  const decision: PromotionDecision = {
    action: "hold",
    reason: "mocked",
    policy_name: "mock",
    policy_version: "v-test"
  };
  const policy: PromotionPolicy = {
    name: "mock",
    version: "v-test",
    decide(context) {
      seen.push(context);
      return decision;
    }
  };
  const evaluator = createPromotionEvaluator({
    policy,
    now: () => NOW
  });

  const result = evaluator.evaluate(createCandidate(), "policy", "tester");

  assert.deepEqual(result, decision);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.trigger, "policy");
  assert.equal(seen[0]?.now, NOW);
  assert.equal(seen[0]?.current_state, "candidate");
});

test("evaluator leaves ack history undefined when no ack-capable store is configured", () => {
  const policy: PromotionPolicy = {
    name: "mock",
    version: "v-test",
    decide(context) {
      assert.equal(context.ack_history, undefined);
      return {
        action: "hold",
        reason: "no ack store",
        policy_name: "mock",
        policy_version: "v-test"
      };
    }
  };
  const evaluator = createPromotionEvaluator({
    policy,
    now: () => NOW
  });

  const result = evaluator.evaluate(createCandidate(), "policy");

  assert.equal(result.action, "hold");
});

test("evaluator forwards recent sufficient ack history when the store exposes a listRecent reader", () => {
  const policy = createDefaultPromotionPolicy({
    rules: { age_threshold_ms: 100_000 }
  });
  const ackStore = {
    put() {
      throw new Error("not used");
    },
    get() {
      return undefined;
    },
    overrideSufficiency() {
      throw new Error("not used");
    },
    countRecent() {
      return 0;
    },
    size() {
      return 3;
    },
    listRecent(filter: { since: number; sufficiency?: AckRecord["sufficiency"] }) {
      assert.equal(filter.sufficiency, "sufficient");
      assert.ok(filter.since <= NOW);
      return [createAck("session-a"), createAck("session-a"), createAck("session-b")];
    }
  } as AckStore;
  const evaluator = createPromotionEvaluator({
    policy,
    ackStore,
    now: () => NOW
  });

  const result = evaluator.evaluate(createCandidate(), "policy");

  assert.equal(result.action, "promote");
});
