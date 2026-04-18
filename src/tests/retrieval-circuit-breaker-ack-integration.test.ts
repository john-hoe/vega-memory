import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import type { Surface, Sufficiency } from "../core/contracts/enums.js";
import { createCheckpointStore } from "../usage/checkpoint-store.js";
import { createAckStore } from "../usage/ack-store.js";
import { createUsageAckMcpTool } from "../usage/usage-ack-handler.js";

function createCheckpoint(surface: Surface) {
  return {
    checkpoint_id: "checkpoint-1",
    bundle_digest: "bundle-1",
    intent: "lookup" as const,
    surface,
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    query_hash: "query-hash",
    mode: "L1" as const,
    profile_used: "lookup",
    ranker_version: "v1.0",
    record_ids: ["vega_memory:mem-1"]
  };
}

function createAck(sufficiency: Sufficiency, overrides: Partial<{ bundle_digest: string }> = {}) {
  return {
    checkpoint_id: "checkpoint-1",
    bundle_digest: "bundle-1",
    sufficiency,
    host_tier: "T2" as const,
    ...overrides
  };
}

function createSpyBreaker() {
  const calls: Array<{ surface: Surface; sufficiency: Sufficiency }> = [];

  return {
    calls,
    breaker: {
      budget_reduction_factor: 0.5,
      recordCheckpoint() {},
      recordAck(surface: Surface, sufficiency: Sufficiency) {
        calls.push({ surface, sufficiency });
      },
      getStatus(surface: Surface) {
        return {
          surface,
          state: "closed" as const,
          tripped_at: null,
          reasons: [],
          consecutive_healthy_samples: 0,
          window_checkpoint_count: 0,
          window_ack_count: 0,
          window_sufficient_ack_count: 0,
          window_needs_followup_ack_count: 0
        };
      },
      listAllStatuses() {
        return [];
      },
      reset() {}
    }
  };
}

test("usage.ack success records breaker ack against the checkpoint surface", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const checkpointStore = createCheckpointStore(db);
    checkpointStore.put(createCheckpoint("codex"));
    const spy = createSpyBreaker();
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, undefined, spy.breaker);

    await tool.invoke(createAck("needs_external"));

    assert.deepEqual(spy.calls, [{ surface: "codex", sufficiency: "needs_external" }]);
  } finally {
    db.close();
  }
});

test("usage.ack digest mismatch does not record breaker ack", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const checkpointStore = createCheckpointStore(db);
    checkpointStore.put(createCheckpoint("codex"));
    const spy = createSpyBreaker();
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, undefined, spy.breaker);

    await tool.invoke(createAck("sufficient", { bundle_digest: "wrong-digest" }));

    assert.deepEqual(spy.calls, []);
  } finally {
    db.close();
  }
});

test("usage.ack conflict does not record breaker ack twice", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const checkpointStore = createCheckpointStore(db);
    checkpointStore.put(createCheckpoint("codex"));
    const spy = createSpyBreaker();
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, undefined, spy.breaker);

    await tool.invoke(createAck("needs_followup"));
    await tool.invoke({
      checkpoint_id: "checkpoint-1",
      bundle_digest: "bundle-1",
      sufficiency: "needs_followup",
      host_tier: "T3"
    });

    assert.deepEqual(spy.calls, [{ surface: "codex", sufficiency: "needs_followup" }]);
  } finally {
    db.close();
  }
});

test("usage.ack idempotent retry with different sufficiency does not mutate breaker samples", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const checkpointStore = createCheckpointStore(db);
    checkpointStore.put(createCheckpoint("codex"));
    const spy = createSpyBreaker();
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, undefined, spy.breaker);

    await tool.invoke(createAck("sufficient"));
    await tool.invoke(createAck("needs_followup"));

    assert.deepEqual(spy.calls, [{ surface: "codex", sufficiency: "sufficient" }]);
  } finally {
    db.close();
  }
});

test("usage.ack identical idempotent retry records the breaker only once", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const checkpointStore = createCheckpointStore(db);
    checkpointStore.put(createCheckpoint("codex"));
    const spy = createSpyBreaker();
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, undefined, spy.breaker);

    await tool.invoke(createAck("sufficient"));
    await tool.invoke(createAck("sufficient"));

    assert.deepEqual(spy.calls, [{ surface: "codex", sufficiency: "sufficient" }]);
  } finally {
    db.close();
  }
});

test("usage.ack records breaker samples for distinct checkpoints", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const checkpointStore = createCheckpointStore(db);
    checkpointStore.put(createCheckpoint("codex"));
    checkpointStore.put({
      ...createCheckpoint("codex"),
      checkpoint_id: "checkpoint-2",
      bundle_digest: "bundle-2"
    });
    const spy = createSpyBreaker();
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, undefined, spy.breaker);

    await tool.invoke(createAck("sufficient"));
    await tool.invoke({
      checkpoint_id: "checkpoint-2",
      bundle_digest: "bundle-2",
      sufficiency: "needs_followup",
      host_tier: "T2"
    });

    assert.deepEqual(spy.calls, [
      { surface: "codex", sufficiency: "sufficient" },
      { surface: "codex", sufficiency: "needs_followup" }
    ]);
  } finally {
    db.close();
  }
});

test("usage.ack skips breaker updates when checkpoint store is unavailable", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const spy = createSpyBreaker();
    const tool = createUsageAckMcpTool(ackStore, undefined, undefined, spy.breaker);

    await tool.invoke(createAck("sufficient"));

    assert.deepEqual(spy.calls, []);
  } finally {
    db.close();
  }
});
