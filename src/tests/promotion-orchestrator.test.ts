import assert from "node:assert/strict";
import test from "node:test";

import { Repository } from "../db/repository.js";
import {
  createCandidateRepository,
  type CandidateMemoryRecord
} from "../db/candidate-repository.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  createPromotionAuditStore
} from "../promotion/audit-store.js";
import type { PromotionAuditStore } from "../promotion/audit-store.js";
import { createPromotionEvaluator } from "../promotion/evaluator.js";
import {
  createPromotionOrchestrator
} from "../promotion/orchestrator.js";
import type { PromotionContext, PromotionDecision, PromotionPolicy } from "../promotion/policy.js";

const NOW = 20_000;

function createCandidateInput() {
  return {
    content: "Candidate memory",
    type: "decision",
    project: "vega-memory",
    tags: ["wave-4"],
    metadata: {},
    extraction_source: "manual",
    extraction_confidence: 0.9,
    visibility_gated: true
  };
}

function createPolicy(
  handler: (context: PromotionContext) => PromotionDecision
): PromotionPolicy {
  return {
    name: "test-policy",
    version: "v-test",
    decide: handler
  };
}

function createHarness(
  policy: PromotionPolicy,
  options: { auditStore?: PromotionAuditStore } = {}
) {
  const db = new SQLiteAdapter(":memory:");
  const repository = new Repository(db);
  let auditClock = NOW;
  const candidateRepository = createCandidateRepository(db, {
    now: () => NOW
  });
  const evaluator = createPromotionEvaluator({
    policy,
    now: () => NOW
  });
  const auditStore =
    options.auditStore ??
    createPromotionAuditStore(db, {
      now: () => ++auditClock,
      idFactory: (() => {
        let index = 0;
        return () => `audit-${++index}`;
      })()
    });
  const orchestrator = createPromotionOrchestrator({
    evaluator,
    candidateRepository,
    repository,
    auditStore
  });

  return {
    db,
    repository,
    candidateRepository,
    auditStore,
    orchestrator,
    close() {
      repository.close();
    }
  };
}

test("promoteManual promotes the candidate, preserves the id, and records audit metadata", () => {
  const harness = createHarness(
    createPolicy(() => ({
      action: "promote",
      reason: "manual promotion",
      policy_name: "test-policy",
      policy_version: "v-test"
    }))
  );

  try {
    const candidate = harness.candidateRepository.create(createCandidateInput());

    const result = harness.orchestrator.promoteManual(candidate.id, "tester");

    assert.equal(result.status, "promoted");
    assert.equal(result.memory_id, candidate.id);
    assert.equal(harness.candidateRepository.findById(candidate.id), undefined);
    assert.equal(harness.repository.getMemory(candidate.id)?.id, candidate.id);
    assert.deepEqual(
      harness.auditStore.listByMemory(candidate.id)[0],
      {
        id: "audit-1",
        memory_id: candidate.id,
        action: "promote",
        trigger: "manual",
        from_state: "candidate",
        to_state: "promoted",
        policy_name: "test-policy",
        policy_version: "v-test",
        reason: "manual promotion",
        actor: "tester",
        occurred_at: NOW + 1
      }
    );
  } finally {
    harness.close();
  }
});

test("demoteManual reuses the same id when moving promoted memories back to held candidates", () => {
  const harness = createHarness(
    createPolicy((context) => ({
      action: context.current_state === "promoted" ? "demote" : "promote",
      reason: context.current_state === "promoted" ? "manual demotion" : "manual promotion",
      policy_name: "test-policy",
      policy_version: "v-test"
    }))
  );

  try {
    const candidate = harness.candidateRepository.create(createCandidateInput());
    harness.orchestrator.promoteManual(candidate.id, "tester");

    const result = harness.orchestrator.demoteManual(candidate.id, "tester", "manual rollback");

    assert.equal(result.status, "demoted");
    assert.equal(result.memory_id, candidate.id);
    assert.equal(harness.repository.getMemory(candidate.id), null);
    assert.equal(harness.candidateRepository.findById(candidate.id)?.id, candidate.id);
    assert.equal(harness.candidateRepository.findById(candidate.id)?.candidate_state, "held");
    assert.deepEqual(
      harness.auditStore.listByMemory(candidate.id).map((entry) => entry.action),
      ["demote", "promote"]
    );
  } finally {
    harness.close();
  }
});

test("evaluateAndAct marks candidates ready on policy promote without promoting them immediately", () => {
  const harness = createHarness(
    createPolicy(() => ({
      action: "promote",
      reason: "ready for promotion",
      policy_name: "test-policy",
      policy_version: "v-test"
    }))
  );

  try {
    const candidate = harness.candidateRepository.create(createCandidateInput());

    const result = harness.orchestrator.evaluateAndAct(candidate.id, "policy");

    assert.equal(result.status, "kept");
    assert.equal(harness.repository.getMemory(candidate.id), null);
    assert.equal(harness.candidateRepository.findById(candidate.id)?.candidate_state, "ready");
    assert.equal(harness.auditStore.listByMemory(candidate.id)[0]?.action, "promote");
  } finally {
    harness.close();
  }
});

test("evaluateAndAct updates held and discarded candidate states without touching promoted memories", () => {
  const harness = createHarness(
    createPolicy((context) => ({
      action: context.candidate.id === "discard-me" ? "discard" : "hold",
      reason: context.candidate.id === "discard-me" ? "never promote" : "keep gathering",
      policy_name: "test-policy",
      policy_version: "v-test"
    }))
  );

  try {
    const held = harness.candidateRepository.create({
      ...createCandidateInput(),
      id: "hold-me"
    });
    const discarded = harness.candidateRepository.create({
      ...createCandidateInput(),
      id: "discard-me"
    });

    const heldResult = harness.orchestrator.evaluateAndAct(held.id, "policy");
    const discardedResult = harness.orchestrator.evaluateAndAct(discarded.id, "policy");

    assert.equal(heldResult.status, "held");
    assert.equal(discardedResult.status, "discarded");
    assert.equal(harness.candidateRepository.findById(held.id)?.candidate_state, "held");
    assert.equal(harness.candidateRepository.findById(discarded.id)?.candidate_state, "discarded");
    assert.equal(harness.repository.getMemory(held.id), null);
    assert.equal(harness.repository.getMemory(discarded.id), null);
  } finally {
    harness.close();
  }
});

test("evaluateAndAct rolls back candidate state changes when audit persistence fails", async () => {
  const harness = createHarness(
    createPolicy(() => ({
      action: "discard",
      reason: "policy rejected the candidate",
      policy_name: "test-policy",
      policy_version: "v-test"
    })),
    {
      auditStore: {
        put() {
          throw new Error("audit write failed");
        },
        listByMemory() {
          return [];
        },
        listRecent() {
          return [];
        },
        size() {
          return 0;
        }
      }
    }
  );

  try {
    const candidate = harness.candidateRepository.create(createCandidateInput());

    await assert.rejects(
      async () => harness.orchestrator.evaluateAndAct(candidate.id, "policy"),
      /audit write failed/
    );
    assert.equal(harness.candidateRepository.findById(candidate.id)?.candidate_state, "pending");
  } finally {
    harness.close();
  }
});

test("runSweep skips discarded candidates so repeated sweeps do not append keep audits", () => {
  const harness = createHarness(
    createPolicy(() => ({
      action: "keep",
      reason: "candidate unchanged",
      policy_name: "test-policy",
      policy_version: "v-test"
    }))
  );

  try {
    const discarded = harness.candidateRepository.create({
      ...createCandidateInput(),
      id: "discarded-candidate",
      candidate_state: "discarded"
    });

    assert.deepEqual(harness.orchestrator.runSweep("sweeper"), []);
    assert.deepEqual(harness.orchestrator.runSweep("sweeper"), []);
    assert.deepEqual(harness.auditStore.listByMemory(discarded.id), []);
    assert.equal(harness.auditStore.size(), 0);
  } finally {
    harness.close();
  }
});

test("promoteManual keeps candidates with invalid memory types and records an audit reason", () => {
  const harness = createHarness(
    createPolicy(() => ({
      action: "promote",
      reason: "manual promotion",
      policy_name: "test-policy",
      policy_version: "v-test"
    }))
  );

  try {
    const candidate = harness.candidateRepository.create({
      ...createCandidateInput(),
      id: "invalid-type-candidate",
      type: "not_a_memory_type"
    });

    const result = harness.orchestrator.promoteManual(candidate.id, "tester");

    assert.equal(result.status, "kept");
    assert.equal(result.decision.action, "keep");
    assert.equal(result.decision.reason, "invalid_type");
    assert.equal(harness.repository.getMemory(candidate.id), null);
    assert.equal(harness.candidateRepository.findById(candidate.id)?.candidate_state, "pending");
    assert.deepEqual(harness.auditStore.listByMemory(candidate.id)[0], {
      id: "audit-1",
      memory_id: candidate.id,
      action: "keep",
      trigger: "manual",
      from_state: "candidate",
      to_state: "candidate",
      policy_name: "test-policy",
      policy_version: "v-test",
      reason: "invalid_type",
      actor: "tester",
      occurred_at: NOW + 1
    });
  } finally {
    harness.close();
  }
});

test("manual promote and demote paths each call policy.decide exactly once", () => {
  let decideCalls = 0;
  const harness = createHarness(
    createPolicy((context) => {
      decideCalls += 1;
      return {
        action: context.current_state === "promoted" ? "demote" : "promote",
        reason: "manual transition",
        policy_name: "test-policy",
        policy_version: "v-test"
      };
    })
  );

  try {
    const candidate = harness.candidateRepository.create(createCandidateInput());

    harness.orchestrator.promoteManual(candidate.id, "tester");
    harness.orchestrator.demoteManual(candidate.id, "tester");

    assert.equal(decideCalls, 2);
  } finally {
    harness.close();
  }
});
