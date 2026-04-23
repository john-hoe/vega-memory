import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { createCandidateRepository } from "../db/candidate-repository.js";
import { createPromotionAuditStore } from "../promotion/audit-store.js";
import {
  applyPromotionFeedbackToRankerConfig,
  applyPromotionFeedbackToSourcePlan,
  collectPromotionFeedback
} from "../retrieval/promotion-feedback.js";
import { DEFAULT_RANKER_CONFIG } from "../retrieval/ranker.js";
import { createSourcePlan } from "../retrieval/source-plan.js";
import { getProfile } from "../retrieval/profiles.js";

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    intent: "lookup" as const,
    mode: "L1" as const,
    query: "vega feedback",
    surface: "codex" as const,
    session_id: "session-feedback",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    ...overrides
  };
}

test("promote audits boost vega_memory source prior", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const auditStore = createPromotionAuditStore(db, {
      now: () => 1_000,
      idFactory: () => "audit-promote"
    });
    auditStore.put({
      memory_id: "memory-1",
      action: "promote",
      trigger: "policy",
      from_state: "held",
      to_state: "promoted",
      policy_name: "default",
      policy_version: "v1",
      reason: "promoted for retrieval",
      actor: null
    });

    const feedback = collectPromotionFeedback({
      request: createRequest(),
      promotionAuditStore: auditStore
    });
    const rankerConfig = applyPromotionFeedbackToRankerConfig(DEFAULT_RANKER_CONFIG, feedback);

    assert.ok((rankerConfig.source_priors.vega_memory ?? 0) > (DEFAULT_RANKER_CONFIG.source_priors.vega_memory ?? 0));
    assert.deepEqual(feedback.preferred_sources, ["vega_memory"]);
  } finally {
    db.close();
  }
});

test("hold and demote signals prefer candidate during followup", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const auditStore = createPromotionAuditStore(db, {
      now: () => 1_000,
      idFactory: (() => {
        let index = 0;
        return () => `audit-${++index}`;
      })()
    });
    auditStore.put({
      memory_id: "memory-held",
      action: "hold",
      trigger: "policy",
      from_state: "pending",
      to_state: "held",
      policy_name: "default",
      policy_version: "v1",
      reason: "held for more evidence",
      actor: null
    });
    auditStore.put({
      memory_id: "memory-demoted",
      action: "demote",
      trigger: "manual",
      from_state: "promoted",
      to_state: "held",
      policy_name: "default",
      policy_version: "v1",
      reason: "sent back to candidate lane",
      actor: "tester"
    });

    const feedback = collectPromotionFeedback({
      request: createRequest({ intent: "followup", prev_checkpoint_id: "checkpoint-1" }),
      promotionAuditStore: auditStore
    });
    const plan = applyPromotionFeedbackToSourcePlan(
      createSourcePlan(getProfile("followup"), createRequest({ intent: "followup", prev_checkpoint_id: "checkpoint-1" })),
      feedback
    );

    assert.equal(plan.primary_sources[0], "candidate");
    assert.ok((feedback.source_prior_delta.candidate ?? 0) > 0);
  } finally {
    db.close();
  }
});

test("discard-dominated candidate lane suppresses candidate source when nothing active remains", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const candidateRepository = createCandidateRepository(db);
    candidateRepository.create({
      id: "discarded-candidate",
      content: "discarded",
      type: "observation",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual",
      visibility_gated: false,
      candidate_state: "discarded"
    });

    const auditStore = createPromotionAuditStore(db, {
      now: () => 1_000,
      idFactory: () => "audit-discard"
    });
    auditStore.put({
      memory_id: "discarded-candidate",
      action: "discard",
      trigger: "policy",
      from_state: "held",
      to_state: "discarded",
      policy_name: "default",
      policy_version: "v1",
      reason: "discarded by policy",
      actor: null
    });

    const feedback = collectPromotionFeedback({
      request: createRequest({ intent: "followup", prev_checkpoint_id: "checkpoint-1" }),
      candidateRepository,
      promotionAuditStore: auditStore
    });
    const plan = applyPromotionFeedbackToSourcePlan(
      createSourcePlan(getProfile("followup"), createRequest({ intent: "followup", prev_checkpoint_id: "checkpoint-1" })),
      feedback
    );

    assert.equal(plan.primary_sources.includes("candidate"), false);
    assert.equal(plan.fallback_sources.includes("candidate"), false);
    assert.ok((feedback.source_prior_delta.candidate ?? 0) < 0);
  } finally {
    db.close();
  }
});

test("nested followup disables promotion feedback to avoid self-reinforcing loops", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const auditStore = createPromotionAuditStore(db, {
      now: () => 1_000,
      idFactory: () => "audit-loop"
    });
    auditStore.put({
      memory_id: "memory-1",
      action: "promote",
      trigger: "policy",
      from_state: "held",
      to_state: "promoted",
      policy_name: "default",
      policy_version: "v1",
      reason: "promoted",
      actor: null
    });

    const feedback = collectPromotionFeedback({
      request: createRequest({ intent: "followup", prev_checkpoint_id: "checkpoint-1" }),
      previousCheckpoint: {
        checkpoint_id: "checkpoint-1",
        bundle_digest: "bundle-1",
        intent: "followup",
        surface: "codex",
        session_id: "session-feedback",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory",
        query_hash: "query",
        mode: "L1",
        profile_used: "followup",
        ranker_version: "v1",
        record_ids: ["wiki:x"],
        prev_checkpoint_id: "root",
        lineage_root_checkpoint_id: "root",
        followup_depth: 1,
        created_at: 1_000,
        ttl_expires_at: 2_000
      },
      promotionAuditStore: auditStore
    });

    assert.equal(feedback.disabled, true);
    assert.deepEqual(feedback.preferred_sources, []);
    assert.deepEqual(feedback.suppressed_sources, []);
  } finally {
    db.close();
  }
});
