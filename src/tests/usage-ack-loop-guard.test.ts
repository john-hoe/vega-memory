import assert from "node:assert/strict";
import test from "node:test";

import type { AckPutResult, AckRecord, AckStore } from "../usage/index.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  createAckStore,
  createCheckpointStore
} from "../usage/index.js";
import { createUsageAckMcpTool } from "../usage/usage-ack-handler.js";

const createAck = (
  overrides: Partial<{
    checkpoint_id: string;
    bundle_digest: string;
    sufficiency: "sufficient" | "needs_followup" | "needs_external";
    host_tier: "T1" | "T2" | "T3";
    evidence?: string;
    turn_elapsed_ms?: number;
  }> = {}
) => ({
  checkpoint_id: "checkpoint-1",
  bundle_digest: "bundle-1",
  sufficiency: "needs_followup" as const,
  host_tier: "T2" as const,
  evidence: "because",
  turn_elapsed_ms: 125,
  ...overrides
});

const createAckForCheckpoint = (
  checkpoint_id: string,
  overrides: Partial<{
    bundle_digest: string;
    sufficiency: "sufficient" | "needs_followup" | "needs_external";
    host_tier: "T1" | "T2" | "T3";
    evidence?: string;
    turn_elapsed_ms?: number;
  }> = {}
) =>
  createAck({
    checkpoint_id,
    bundle_digest: `bundle-${checkpoint_id}`,
    ...overrides
  });

function seedCheckpoint(
  store: ReturnType<typeof createCheckpointStore>,
  checkpoint_id: string,
  session_id: string
): void {
  store.put({
    checkpoint_id,
    bundle_digest: `bundle-${checkpoint_id}`,
    intent: "lookup",
    surface: "codex",
    session_id,
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    query_hash: `query-${checkpoint_id}`,
    mode: "L1",
    profile_used: "lookup",
    ranker_version: "v1.0",
    record_ids: [`wiki:${checkpoint_id}`]
  });
}

test("needs_followup loop guard fires on the second and later ack within the same session", async () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const ackStore = createAckStore(db, { now: () => now });
    const checkpointStore = createCheckpointStore(db, { now: () => now });
    seedCheckpoint(checkpointStore, "checkpoint-1", "session-loop");
    seedCheckpoint(checkpointStore, "checkpoint-2", "session-loop");
    seedCheckpoint(checkpointStore, "checkpoint-3", "session-loop");

    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => now);

    const first = await tool.invoke(createAckForCheckpoint("checkpoint-1"));
    now += 1;
    const second = await tool.invoke(createAckForCheckpoint("checkpoint-2"));
    now += 1;
    const third = await tool.invoke(createAckForCheckpoint("checkpoint-3"));

    assert.deepEqual(first, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
    assert.deepEqual(second, {
      ack: true,
      degraded: "needs_followup_loop_limit",
      forced_sufficiency: "needs_external"
    });
    assert.deepEqual(third, {
      ack: true,
      degraded: "needs_followup_loop_limit",
      forced_sufficiency: "needs_external"
    });
    assert.equal(
      ackStore.countRecent({
        session_id: "session-loop",
        sufficiency: "needs_followup",
        since: 0
      }),
      1
    );
    assert.equal(ackStore.get("checkpoint-2")?.sufficiency, "needs_external");
    assert.equal(ackStore.get("checkpoint-2")?.guard_overridden, true);
    assert.equal(ackStore.get("checkpoint-3")?.sufficiency, "needs_external");
    assert.equal(ackStore.get("checkpoint-3")?.guard_overridden, true);
  } finally {
    db.close();
  }
});

test("same-checkpoint retries remain idempotent and keep the original needs_followup state", async () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const ackStore = createAckStore(db, { now: () => now });
    const checkpointStore = createCheckpointStore(db, { now: () => now });
    seedCheckpoint(checkpointStore, "checkpoint-1", "session-loop");
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => now);

    const first = await tool.invoke(createAckForCheckpoint("checkpoint-1"));
    now += 1;
    const second = await tool.invoke(createAckForCheckpoint("checkpoint-1"));

    assert.deepEqual(second, first);
    assert.equal(ackStore.size(), 1);
    assert.equal(ackStore.get("checkpoint-1")?.sufficiency, "needs_followup");
    assert.equal(ackStore.get("checkpoint-1")?.guard_overridden, false);
  } finally {
    db.close();
  }
});

test("idempotent retries do not suppress the loop guard for a later checkpoint in the same session", async () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const ackStore = createAckStore(db, { now: () => now });
    const checkpointStore = createCheckpointStore(db, { now: () => now });
    seedCheckpoint(checkpointStore, "checkpoint-1", "session-loop");
    seedCheckpoint(checkpointStore, "checkpoint-2", "session-loop");
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => now);

    const first = await tool.invoke(
      createAckForCheckpoint("checkpoint-1", {
        sufficiency: "needs_followup"
      })
    );
    now += 1;
    const retry = await tool.invoke(
      createAckForCheckpoint("checkpoint-1", {
        sufficiency: "sufficient"
      })
    );
    now += 1;
    const secondCheckpoint = await tool.invoke(createAckForCheckpoint("checkpoint-2"));

    assert.deepEqual(first, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
    assert.deepEqual(retry, first);
    assert.deepEqual(secondCheckpoint, {
      ack: true,
      degraded: "needs_followup_loop_limit",
      forced_sufficiency: "needs_external"
    });
    assert.equal(ackStore.get("checkpoint-1")?.sufficiency, "needs_followup");
    assert.equal(ackStore.get("checkpoint-2")?.sufficiency, "needs_external");
    assert.equal(ackStore.get("checkpoint-2")?.guard_overridden, true);
  } finally {
    db.close();
  }
});

test("retry-after-override rebuilds the same degraded response from the stored ack record", async () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const ackStore = createAckStore(db, { now: () => now });
    const checkpointStore = createCheckpointStore(db, { now: () => now });
    seedCheckpoint(checkpointStore, "checkpoint-1", "session-loop");
    seedCheckpoint(checkpointStore, "checkpoint-2", "session-loop");
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => now);

    await tool.invoke(createAckForCheckpoint("checkpoint-1"));
    now += 1;
    const first = await tool.invoke(createAckForCheckpoint("checkpoint-2"));
    const storedAfterOverride = ackStore.get("checkpoint-2");
    now += 1;
    const retry = await tool.invoke(createAckForCheckpoint("checkpoint-2"));

    assert.deepEqual(first, {
      ack: true,
      degraded: "needs_followup_loop_limit",
      forced_sufficiency: "needs_external"
    });
    assert.deepEqual(retry, first);
    assert.equal(storedAfterOverride?.sufficiency, "needs_external");
    assert.equal(storedAfterOverride?.guard_overridden, true);
    assert.equal(ackStore.get("checkpoint-2")?.acked_at, storedAfterOverride?.acked_at);
  } finally {
    db.close();
  }
});

test("needs_followup loop guard counts sessions independently", async () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const ackStore = createAckStore(db, { now: () => now });
    const checkpointStore = createCheckpointStore(db, { now: () => now });
    seedCheckpoint(checkpointStore, "checkpoint-a1", "session-a");
    seedCheckpoint(checkpointStore, "checkpoint-a2", "session-a");
    seedCheckpoint(checkpointStore, "checkpoint-b1", "session-b");

    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => now);

    await tool.invoke(createAckForCheckpoint("checkpoint-a1"));
    now += 1;
    await tool.invoke(createAckForCheckpoint("checkpoint-a2"));
    now += 1;
    const result = await tool.invoke(createAckForCheckpoint("checkpoint-b1"));

    assert.deepEqual(result, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
  } finally {
    db.close();
  }
});

test("loop guard ignores non-needs_followup acknowledgements", async () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const ackStore = createAckStore(db, { now: () => now });
    const checkpointStore = createCheckpointStore(db, { now: () => now });
    seedCheckpoint(checkpointStore, "checkpoint-1", "session-mixed");
    seedCheckpoint(checkpointStore, "checkpoint-2", "session-mixed");

    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => now);

    await tool.invoke(
      createAck({
        checkpoint_id: "checkpoint-1",
        bundle_digest: "bundle-checkpoint-1",
        sufficiency: "sufficient"
      })
    );
    now += 1;
    const result = await tool.invoke(
      createAck({
        checkpoint_id: "checkpoint-2",
        bundle_digest: "bundle-checkpoint-2",
        sufficiency: "needs_external"
      })
    );

    assert.deepEqual(result, { ack: true });
  } finally {
    db.close();
  }
});

test("loop guard only counts acknowledgements inside the configured window", async () => {
  const db = new SQLiteAdapter(":memory:");
  const originalWindow = process.env.VEGA_LOOP_GUARD_WINDOW_MS;
  let now = 1_000;

  try {
    process.env.VEGA_LOOP_GUARD_WINDOW_MS = "10";

    const ackStore = createAckStore(db, { now: () => now });
    const checkpointStore = createCheckpointStore(db, { now: () => now });
    seedCheckpoint(checkpointStore, "checkpoint-1", "session-window");
    seedCheckpoint(checkpointStore, "checkpoint-2", "session-window");

    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => now);

    await tool.invoke(createAckForCheckpoint("checkpoint-1"));
    now += 11;
    const result = await tool.invoke(createAckForCheckpoint("checkpoint-2"));

    assert.deepEqual(result, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
  } finally {
    if (originalWindow === undefined) {
      delete process.env.VEGA_LOOP_GUARD_WINDOW_MS;
    } else {
      process.env.VEGA_LOOP_GUARD_WINDOW_MS = originalWindow;
    }
    db.close();
  }
});

test("loop guard never fires when checkpointStore is omitted and session_id stays null", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db, { now: () => 1_000 });
    const tool = createUsageAckMcpTool(ackStore, undefined, () => 1_000);

    const first = await tool.invoke(createAck({ checkpoint_id: "checkpoint-1" }));
    const second = await tool.invoke(createAck({ checkpoint_id: "checkpoint-2" }));

    assert.deepEqual(first, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
    assert.deepEqual(second, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
  } finally {
    db.close();
  }
});

test("overrideSufficiency failure keeps first-answer and retry responses consistent", async () => {
  // When guard fires but overrideSufficiency throws, stored state stays as
  // sufficiency=needs_followup + guard_overridden=false. Retry would be
  // idempotent and return follow_up_hint via buildResponseFromRecord.
  // First-answer must match that — NOT return loop_limit/forced_sufficiency.
  const saved: AckRecord[] = [];
  const ackStore: AckStore = {
    put(ack): AckPutResult {
      const stored: AckRecord = {
        ...ack,
        evidence: ack.evidence ?? null,
        turn_elapsed_ms: ack.turn_elapsed_ms ?? null,
        session_id: ack.session_id ?? null,
        acked_at: 1_000,
        guard_overridden: false
      };
      saved.push(stored);
      return { record: stored, status: "inserted" };
    },
    get(checkpoint_id: string) {
      return saved.find((ack) => ack.checkpoint_id === checkpoint_id);
    },
    overrideSufficiency() {
      throw new Error("override persistence failed");
    },
    countRecent() {
      // Simulate an existing prior needs_followup in this session so guard would fire
      return 1;
    },
    size() {
      return saved.length;
    }
  };
  const db = new SQLiteAdapter(":memory:");

  try {
    const checkpointStore = createCheckpointStore(db, { now: () => 1_000 });
    seedCheckpoint(checkpointStore, "cp-fail", "session-override-fail");
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => 1_000);

    const result = await tool.invoke(createAckForCheckpoint("cp-fail"));

    assert.deepEqual(result, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
    // Persisted row keeps pre-override state — this is what a retry would see.
    assert.equal(saved[0].sufficiency, "needs_followup");
    assert.equal(saved[0].guard_overridden, false);
  } finally {
    db.close();
  }
});

test("countRecent failures do not block the host turn", async () => {
  const saved: AckRecord[] = [];
  const ackStore: AckStore = {
    put(ack): AckPutResult {
      const stored = {
        ...ack,
        evidence: ack.evidence ?? null,
        turn_elapsed_ms: ack.turn_elapsed_ms ?? null,
        session_id: ack.session_id ?? null,
        acked_at: 1_000,
        guard_overridden: false
      };
      saved.push(stored);
      return {
        record: stored,
        status: "inserted"
      };
    },
    get() {
      return undefined;
    },
    overrideSufficiency() {
      throw new Error("should not override when countRecent fails");
    },
    countRecent() {
      throw new Error("count failed");
    },
    size() {
      return saved.length;
    }
  };
  const db = new SQLiteAdapter(":memory:");

  try {
    const checkpointStore = createCheckpointStore(db, { now: () => 1_000 });
    seedCheckpoint(checkpointStore, "checkpoint-1", "session-throw");
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => 1_000);

    const result = await tool.invoke(createAckForCheckpoint("checkpoint-1"));

    assert.deepEqual(result, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
    assert.equal(saved.length, 1);
  } finally {
    db.close();
  }
});
