import assert from "node:assert/strict";
import test from "node:test";

import { Repository } from "../db/repository.js";
import { createCandidateRepository } from "../db/candidate-repository.js";
import { createShadowAwareRepository } from "../db/shadow-aware-repository.js";
import { applyRawInboxMigration, queryRawInbox } from "../ingestion/raw-inbox.js";
import { createShadowWriter } from "../ingestion/shadow-writer.js";
import { createPromotionAuditStore } from "../promotion/audit-store.js";
import { createPromotionEvaluator } from "../promotion/evaluator.js";
import { createPromotionOrchestrator } from "../promotion/orchestrator.js";

const FEATURE_FLAG = "VEGA_SHADOW_DUAL_WRITE";

function withFeatureFlag<T>(value: string | undefined, run: () => T): T {
  const previous = process.env[FEATURE_FLAG];

  if (value === undefined) {
    delete process.env[FEATURE_FLAG];
  } else {
    process.env[FEATURE_FLAG] = value;
  }

  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[FEATURE_FLAG];
    } else {
      process.env[FEATURE_FLAG] = previous;
    }
  }
}

test("createFromCandidate reuses the candidate id for the promoted memory", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createFromCandidate("candidate-1", {
      content: "Promote this\nWith details.",
      type: "decision",
      project: "vega-memory",
      tags: ["wave-4", "candidate"]
    });

    const stored = repository.getMemory("candidate-1");

    assert.ok(stored);
    assert.equal(stored?.id, "candidate-1");
    assert.equal(stored?.type, "decision");
    assert.equal(stored?.project, "vega-memory");
    assert.equal(stored?.title, "Promote this");
    assert.deepEqual(stored?.tags, ["wave-4", "candidate"]);
  } finally {
    repository.close();
  }
});

test("createFromCandidate surfaces primary-key conflicts on repeated promotion", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createFromCandidate("candidate-1", {
      content: "Promote this",
      type: "decision",
      project: "vega-memory",
      tags: []
    });

    assert.throws(() =>
      repository.createFromCandidate("candidate-1", {
        content: "Promote this again",
        type: "decision",
        project: "vega-memory",
        tags: []
      })
    );
  } finally {
    repository.close();
  }
});

test("createFromCandidate rejects invalid candidate memory types without inserting a memory row", () => {
  const repository = new Repository(":memory:");

  try {
    assert.throws(
      () =>
        repository.createFromCandidate("candidate-invalid", {
          content: "Reject this",
          type: "not_a_memory_type",
          project: "vega-memory",
          tags: []
        }),
      /InvalidCandidateType/
    );
    assert.equal(repository.getMemory("candidate-invalid"), null);
    assert.equal(repository.listMemories({ limit: 10 }).length, 0);
  } finally {
    repository.close();
  }
});

test("demoteToCandidate removes the promoted memory and reports whether anything changed", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createFromCandidate("candidate-1", {
      content: "Promote this",
      type: "decision",
      project: "vega-memory",
      tags: []
    });

    assert.equal(repository.demoteToCandidate("candidate-1"), true);
    assert.equal(repository.getMemory("candidate-1"), null);
    assert.equal(repository.demoteToCandidate("candidate-1"), false);
  } finally {
    repository.close();
  }
});

test("shadow-aware repository writes a raw_inbox row for createFromCandidate when the feature flag is on", () => {
  withFeatureFlag("true", () => {
    const repository = new Repository(":memory:");
    const candidateId = "77777777-7777-4777-8777-777777777777";

    try {
      applyRawInboxMigration(repository.db);
      const wrapped = createShadowAwareRepository(
        repository,
        createShadowWriter({ db: repository.db })
      );

      wrapped.createFromCandidate(candidateId, {
        content: "Promote this",
        type: "decision",
        project: "vega-memory",
        tags: ["wave-4"]
      });

      const rows = queryRawInbox(repository.db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_id, candidateId);
    } finally {
      repository.close();
    }
  });
});

test("promoteManual preserves promotion provenance on the stored memory and raw_inbox row", () => {
  withFeatureFlag("true", () => {
    const repository = new Repository(":memory:");

    try {
      applyRawInboxMigration(repository.db);
      const wrapped = createShadowAwareRepository(
        repository,
        createShadowWriter({ db: repository.db })
      );
      const candidateRepository = createCandidateRepository(repository.db);
      const auditStore = createPromotionAuditStore(repository.db, {
        now: () => 1_000,
        idFactory: () => "audit-1"
      });
      const evaluator = createPromotionEvaluator({
        now: () => 1_000,
        policy: {
          name: "test-policy",
          version: "v1",
          decide() {
            return {
              action: "promote",
              reason: "manual promotion",
              policy_name: "test-policy",
              policy_version: "v1"
            };
          }
        }
      });
      const orchestrator = createPromotionOrchestrator({
        evaluator,
        candidateRepository,
        repository: wrapped,
        auditStore
      });
      const candidate = candidateRepository.create({
        content: "Promote me",
        type: "decision",
        project: "vega-memory",
        tags: ["wave-4"],
        metadata: {},
        extraction_source: "manual"
      });

      orchestrator.promoteManual(candidate.id, "alice");

      const stored = wrapped.getMemory(candidate.id);
      const rows = queryRawInbox(repository.db, { event_id: candidate.id });

      assert.equal(stored?.source_context?.actor, "alice");
      assert.equal(stored?.source_context?.channel, "vega_internal");
      assert.equal(stored?.source_context?.client_info, "manual");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_type, "state_change");
      assert.equal(rows[0]?.session_id.startsWith("legacy-"), false);
    } finally {
      repository.close();
    }
  });
});
