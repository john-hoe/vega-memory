import assert from "node:assert/strict";
import test from "node:test";

import { recordKey } from "../core/contracts/checkpoint-record.js";
import type { CandidateMemoryRecord } from "../db/candidate-repository.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { createPromotionEvaluator } from "../promotion/evaluator.js";
import { createDefaultPromotionPolicy } from "../promotion/policy.js";
import { createAckStore } from "../usage/ack-store.js";
import { createCheckpointStore } from "../usage/checkpoint-store.js";

const NOW = 10_000;

function createCandidate(overrides: Partial<CandidateMemoryRecord> = {}): CandidateMemoryRecord {
  return {
    id: "candidate-1",
    content: "Candidate memory",
    type: "decision",
    project: "vega-memory",
    tags: ["wave-8"],
    metadata: {},
    extraction_source: "manual",
    extraction_confidence: 0.9,
    promotion_score: 0,
    visibility_gated: true,
    candidate_state: "pending",
    created_at: NOW,
    updated_at: NOW,
    ...overrides
  };
}

function seedAck(options: {
  db: SQLiteAdapter;
  checkpoint_id: string;
  session_id: string;
  acked_at: number;
  record_ids: string[];
}): void {
  const checkpointStore = createCheckpointStore(options.db, {
    now: () => options.acked_at
  });
  const ackStore = createAckStore(options.db, {
    now: () => options.acked_at
  });

  checkpointStore.put({
    checkpoint_id: options.checkpoint_id,
    bundle_digest: `${options.checkpoint_id}-bundle`,
    intent: "lookup",
    surface: "codex",
    session_id: options.session_id,
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    query_hash: `${options.checkpoint_id}-query`,
    mode: "L1",
    profile_used: "lookup",
    ranker_version: "test",
    record_ids: options.record_ids
  });

  ackStore.put({
    checkpoint_id: options.checkpoint_id,
    bundle_digest: `${options.checkpoint_id}-bundle`,
    sufficiency: "sufficient",
    host_tier: "T2",
    evidence: null,
    turn_elapsed_ms: null,
    session_id: options.session_id
  });
}

test("unrelated acks cannot promote a candidate with no lineage-bound validation", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const candidate = createCandidate();
    const evaluator = createPromotionEvaluator({
      policy: createDefaultPromotionPolicy({
        age_threshold_ms: 1_000_000
      }),
      ackStore: createAckStore(db),
      now: () => NOW + 100
    });

    seedAck({
      db,
      checkpoint_id: "checkpoint-1",
      session_id: "session-a",
      acked_at: NOW + 10,
      record_ids: [recordKey("wiki", "wiki-1")]
    });
    seedAck({
      db,
      checkpoint_id: "checkpoint-2",
      session_id: "session-b",
      acked_at: NOW + 20,
      record_ids: [recordKey("vega_memory", "mem-2")]
    });
    seedAck({
      db,
      checkpoint_id: "checkpoint-3",
      session_id: "session-c",
      acked_at: NOW + 30,
      record_ids: [recordKey("fact_claim", "fact-3")]
    });

    const decision = evaluator.evaluate(candidate, "policy");

    assert.equal(decision.action, "hold");
  } finally {
    db.close();
  }
});

test("lineage-bound acks promote once three sufficient sessions validate the same candidate lineage", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const candidate = createCandidate();
    const evaluator = createPromotionEvaluator({
      policy: createDefaultPromotionPolicy({
        age_threshold_ms: 1_000_000
      }),
      ackStore: createAckStore(db),
      now: () => NOW + 100
    });
    const candidateRecordId = recordKey("candidate", candidate.id);

    seedAck({
      db,
      checkpoint_id: "checkpoint-1",
      session_id: "session-a",
      acked_at: NOW + 10,
      record_ids: [candidateRecordId]
    });
    seedAck({
      db,
      checkpoint_id: "checkpoint-2",
      session_id: "session-b",
      acked_at: NOW + 20,
      record_ids: [candidateRecordId]
    });
    seedAck({
      db,
      checkpoint_id: "checkpoint-3",
      session_id: "session-c",
      acked_at: NOW + 30,
      record_ids: [candidateRecordId]
    });

    const decision = evaluator.evaluate(candidate, "policy");

    assert.equal(decision.action, "promote");
  } finally {
    db.close();
  }
});

test("mixed lineage and unrelated acks only count the lineage-bound subset", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const candidate = createCandidate();
    const evaluator = createPromotionEvaluator({
      policy: createDefaultPromotionPolicy({
        age_threshold_ms: 1_000_000
      }),
      ackStore: createAckStore(db),
      now: () => NOW + 100
    });
    const candidateRecordId = recordKey("candidate", candidate.id);

    seedAck({
      db,
      checkpoint_id: "checkpoint-1",
      session_id: "session-a",
      acked_at: NOW + 10,
      record_ids: [candidateRecordId]
    });
    seedAck({
      db,
      checkpoint_id: "checkpoint-2",
      session_id: "session-b",
      acked_at: NOW + 20,
      record_ids: [candidateRecordId]
    });
    seedAck({
      db,
      checkpoint_id: "checkpoint-3",
      session_id: "session-c",
      acked_at: NOW + 30,
      record_ids: [recordKey("wiki", "wiki-3")]
    });

    const decision = evaluator.evaluate(candidate, "policy");

    assert.equal(decision.action, "hold");
  } finally {
    db.close();
  }
});
