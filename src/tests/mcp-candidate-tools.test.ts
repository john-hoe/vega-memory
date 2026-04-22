import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { createCandidateRepository } from "../db/candidate-repository.js";
import {
  createCandidateCreateMcpTool,
  createCandidateEvaluateMcpTool,
  createCandidateDemoteMcpTool,
  createCandidateListMcpTool,
  createCandidatePromoteMcpTool,
  createCandidateSweepMcpTool
} from "../promotion/candidate-mcp-tools.js";

test("candidate_create creates a pending candidate when the repository is available", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db, {
      now: () => 1_000
    });
    const tool = createCandidateCreateMcpTool(repository);

    const result = await tool.invoke({
      content: "Candidate memory",
      type: "decision",
      project: "vega-memory",
      tags: ["wave-4"],
      metadata: {
        source: "candidate"
      },
      extraction_source: "manual",
      extraction_confidence: 0.9,
      visibility_gated: true
    });

    assert.ok(!("degraded" in result));
    assert.equal(typeof result.id, "string");
    assert.equal(result.candidate_state, "pending");
    assert.equal(result.created_at, 1_000);
  } finally {
    db.close();
  }
});

test("candidate_create rejects invalid memory types at schema validation time", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db, {
      now: () => 1_000
    });
    const tool = createCandidateCreateMcpTool(repository);

    await assert.rejects(
      async () =>
        tool.invoke({
          content: "Candidate memory",
          type: "not_a_memory_type",
          project: "vega-memory",
          tags: ["wave-4"],
          metadata: {},
          extraction_source: "manual",
          extraction_confidence: 0.9,
          visibility_gated: true
        }),
      (error: unknown) => error instanceof Error && error.name === "ZodError"
    );
    assert.equal(repository.size(), 0);
  } finally {
    db.close();
  }
});

test("candidate_list supports state filtering and degrades cleanly without a repository", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db, {
      now: (() => {
        let now = 1_000;
        return () => ++now;
      })()
    });
    const availableTool = createCandidateListMcpTool(repository);
    const unavailableTool = createCandidateListMcpTool(undefined);
    const pending = repository.create({
      content: "Pending candidate",
      type: "decision",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual"
    });
    const ready = repository.create({
      content: "Ready candidate",
      type: "decision",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual"
    });
    repository.updateState(ready.id, "ready");

    const filtered = await availableTool.invoke({
      state: "ready"
    });
    const degraded = await unavailableTool.invoke({});

    assert.ok(!("degraded" in filtered));
    assert.deepEqual(filtered.records.map((record) => record.id), [ready.id]);
    assert.equal(filtered.records[0]?.candidate_state, "ready");
    assert.deepEqual(degraded, {
      degraded: "candidate_store_unavailable"
    });
    assert.equal(repository.findById(pending.id)?.candidate_state, "pending");
  } finally {
    db.close();
  }
});

test("candidate_promote and candidate_demote surface orchestrator results and degraded availability", async () => {
  const orchestrator = {
    promoteManual(id: string, actor: string) {
      return {
        status: "promoted" as const,
        memory_id: id,
        decision: {
          action: "promote" as const,
          reason: `${actor} promoted the candidate`,
          policy_name: "default",
          policy_version: "v1"
        },
        audit_entry_id: "audit-promote"
      };
    },
    demoteManual(id: string, actor: string, reason?: string) {
      return {
        status: "demoted" as const,
        memory_id: id,
        decision: {
          action: "demote" as const,
          reason: reason ?? `${actor} demoted the memory`,
          policy_name: "default",
          policy_version: "v1"
        },
        audit_entry_id: "audit-demote"
      };
    }
  };
  const promoteTool = createCandidatePromoteMcpTool(orchestrator as never);
  const demoteTool = createCandidateDemoteMcpTool(orchestrator as never);
  const degradedPromoteTool = createCandidatePromoteMcpTool(undefined);

  const promoted = await promoteTool.invoke({
    id: "candidate-1",
    actor: "tester"
  });
  const demoted = await demoteTool.invoke({
    id: "candidate-1",
    actor: "tester",
    reason: "manual rollback"
  });
  const degraded = await degradedPromoteTool.invoke({
    id: "candidate-1",
    actor: "tester"
  });

  assert.deepEqual(promoted, {
    status: "promoted",
    memory_id: "candidate-1",
    audit_entry_id: "audit-promote",
    reason: "tester promoted the candidate"
  });
  assert.deepEqual(demoted, {
    status: "demoted",
    memory_id: "candidate-1",
    audit_entry_id: "audit-demote",
    reason: "manual rollback"
  });
  assert.deepEqual(degraded, {
    degraded: "promotion_unavailable"
  });
});

test("mutation tools throw when the orchestrator rejects an explicit candidate action", async () => {
  const promoteTool = createCandidatePromoteMcpTool({
    promoteManual() {
      throw new Error("CandidateNotFound");
    }
  } as never);

  await assert.rejects(
    () =>
      promoteTool.invoke({
        id: "missing",
        actor: "tester"
      }),
    /CandidateNotFound/
  );
});

test("candidate_evaluate and candidate_sweep expose policy and sweep runtime paths", async () => {
  const calls: Array<{ kind: "evaluate" | "sweep"; id?: string; trigger?: string; actor?: string }> = [];
  const orchestrator = {
    evaluateAndAct(id: string, trigger: string, actor?: string) {
      calls.push({ kind: "evaluate", id, trigger, actor });
      return {
        status: "held" as const,
        memory_id: id,
        decision: {
          action: "hold" as const,
          reason: "policy reviewed candidate",
          policy_name: "default",
          policy_version: "v1"
        },
        audit_entry_id: "audit-evaluate"
      };
    },
    runSweep(actor?: string) {
      calls.push({ kind: "sweep", actor });
      return [
        {
          status: "promoted" as const,
          memory_id: "candidate-1",
          decision: {
            action: "promote" as const,
            reason: "sweep promoted candidate",
            policy_name: "default",
            policy_version: "v1"
          },
          audit_entry_id: "audit-sweep"
        }
      ];
    }
  };

  const evaluateTool = createCandidateEvaluateMcpTool(orchestrator as never);
  const sweepTool = createCandidateSweepMcpTool(orchestrator as never);

  const evaluated = await evaluateTool.invoke({
    id: "candidate-1",
    actor: "tester"
  });
  const swept = await sweepTool.invoke({
    actor: "scheduler"
  });

  assert.deepEqual(evaluated, {
    status: "held",
    memory_id: "candidate-1",
    audit_entry_id: "audit-evaluate",
    reason: "policy reviewed candidate"
  });
  assert.deepEqual(swept, {
    results: [
      {
        status: "promoted",
        memory_id: "candidate-1",
        audit_entry_id: "audit-sweep",
        reason: "sweep promoted candidate"
      }
    ]
  });
  assert.deepEqual(calls, [
    {
      kind: "evaluate",
      id: "candidate-1",
      trigger: "policy",
      actor: "tester"
    },
    {
      kind: "sweep",
      actor: "scheduler"
    }
  ]);
});

test("candidate_evaluate and candidate_sweep degrade cleanly when promotion runtime is unavailable", async () => {
  const evaluateTool = createCandidateEvaluateMcpTool(undefined);
  const sweepTool = createCandidateSweepMcpTool(undefined);

  assert.deepEqual(
    await evaluateTool.invoke({
      id: "candidate-1"
    }),
    {
      degraded: "promotion_unavailable"
    }
  );
  assert.deepEqual(
    await sweepTool.invoke({}),
    {
      degraded: "promotion_unavailable"
    }
  );
});
