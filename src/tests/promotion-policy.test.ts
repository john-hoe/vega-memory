import assert from "node:assert/strict";
import test from "node:test";

import type { CandidateMemoryRecord } from "../db/candidate-repository.js";
import type { AckRecord } from "../usage/ack-store.js";
import { createDefaultPromotionPolicy } from "../promotion/policy.js";

const NOW = 10 * 24 * 60 * 60 * 1_000;

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
    created_at: NOW - 1_000,
    updated_at: NOW - 1_000,
    ...overrides
  };
}

function createAck(session_id: string, sufficiency: AckRecord["sufficiency"] = "sufficient"): AckRecord {
  return {
    checkpoint_id: `${session_id}-${Math.random()}`,
    bundle_digest: `bundle-${session_id}`,
    sufficiency,
    host_tier: "T2",
    evidence: null,
    turn_elapsed_ms: null,
    session_id,
    acked_at: NOW - 100,
    guard_overridden: false
  };
}

test("manual trigger promotes candidates even when they were previously discarded", () => {
  const policy = createDefaultPromotionPolicy();

  const decision = policy.decide({
    candidate: createCandidate({ candidate_state: "discarded" }),
    current_state: "candidate",
    trigger: "manual",
    now: NOW
  });

  assert.equal(decision.action, "promote");
});

test("manual trigger demotes already-promoted memories through the same policy entry", () => {
  const policy = createDefaultPromotionPolicy();

  const decision = policy.decide({
    candidate: createCandidate(),
    current_state: "promoted",
    trigger: "manual",
    now: NOW
  });

  assert.equal(decision.action, "demote");
});

test("discarded candidates short-circuit to keep before age and ack rules", () => {
  const policy = createDefaultPromotionPolicy({
    rules: { age_threshold_ms: 1 }
  });

  const decision = policy.decide({
    candidate: createCandidate({
      candidate_state: "discarded",
      created_at: 0
    }),
    current_state: "candidate",
    trigger: "policy",
    now: NOW,
    ack_history: [
      createAck("session-a"),
      createAck("session-a"),
      createAck("session-b")
    ]
  });

  assert.equal(decision.action, "keep");
});

test("old enough candidates are promoted by the age rule", () => {
  const policy = createDefaultPromotionPolicy({
    rules: { age_threshold_ms: 7 * 24 * 60 * 60 * 1_000 }
  });

  const decision = policy.decide({
    candidate: createCandidate({
      created_at: NOW - 8 * 24 * 60 * 60 * 1_000
    }),
    current_state: "candidate",
    trigger: "policy",
    now: NOW
  });

  assert.equal(decision.action, "promote");
  assert.match(decision.reason, /age/i);
});

test("ack signal promotes younger candidates when the distinct-session threshold is met", () => {
  const policy = createDefaultPromotionPolicy({
    rules: { age_threshold_ms: 30 * 24 * 60 * 60 * 1_000 }
  });

  const decision = policy.decide({
    candidate: createCandidate({
      created_at: NOW - 1_000
    }),
    current_state: "candidate",
    trigger: "policy",
    now: NOW,
    ack_history: [
      createAck("session-a"),
      createAck("session-a"),
      createAck("session-b"),
      createAck("session-b", "needs_followup")
    ]
  });

  assert.equal(decision.action, "promote");
  assert.match(decision.reason, /ack/i);
});

test("fallback stays on hold when neither age nor ack rules say promote", () => {
  const policy = createDefaultPromotionPolicy({
    rules: { age_threshold_ms: 30 * 24 * 60 * 60 * 1_000 }
  });

  const decision = policy.decide({
    candidate: createCandidate({
      created_at: NOW - 1_000
    }),
    current_state: "candidate",
    trigger: "policy",
    now: NOW,
    ack_history: [createAck("session-a"), createAck("session-a")]
  });

  assert.equal(decision.action, "hold");
});
