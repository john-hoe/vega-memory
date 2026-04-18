import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  createAckStore,
  createCheckpointStore,
  type AckPutResult,
  type AckStore
} from "../usage/index.js";
import {
  createUsageAckHttpHandler,
  createUsageAckMcpTool
} from "../usage/usage-ack-handler.js";

interface StubResponse {
  statusCode: number;
  body: unknown;
  status(code: number): StubResponse;
  json(payload: unknown): StubResponse;
}

const createResponse = (): StubResponse => ({
  statusCode: 200,
  body: undefined,
  status(code: number) {
    this.statusCode = code;
    return this;
  },
  json(payload: unknown) {
    this.body = payload;
    return this;
  }
});

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
  sufficiency: "sufficient" as const,
  host_tier: "T2" as const,
  evidence: "because",
  turn_elapsed_ms: 125,
  ...overrides
});

const createThrowingAckStore = (): AckStore => ({
  put() {
    throw new Error("db write failed");
  },
  get() {
    return undefined;
  },
  overrideSufficiency() {
    throw new Error("override should not run");
  },
  countRecent() {
    return 0;
  },
  size() {
    return 0;
  }
});

test("HTTP handler returns ack true for a valid payload without follow_up_hint or degraded", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageAckHttpHandler(createAckStore(db));
    const response = createResponse();

    await handler({ body: createAck() } as never, response as never);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ack: true });
  } finally {
    db.close();
  }
});

test("HTTP handler returns a follow_up_hint for needs_followup", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageAckHttpHandler(createAckStore(db));
    const response = createResponse();

    await handler(
      {
        body: createAck({
          sufficiency: "needs_followup"
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
  } finally {
    db.close();
  }
});

test("HTTP handler omits follow_up_hint for needs_external", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageAckHttpHandler(createAckStore(db));
    const response = createResponse();

    await handler(
      {
        body: createAck({
          sufficiency: "needs_external"
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ack: true });
  } finally {
    db.close();
  }
});

test("HTTP handler returns 400 for an invalid payload", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageAckHttpHandler(createAckStore(db));
    const response = createResponse();

    await handler(
      {
        body: {
          checkpoint_id: "checkpoint-1",
          bundle_digest: "bundle-1",
          sufficiency: "sufficient"
        }
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error?: string }).error, "ValidationError");
    assert.match(String((response.body as { detail?: string }).detail), /host_tier/i);
  } finally {
    db.close();
  }
});

test("HTTP handler keeps the first write for the same checkpoint when bundle and host tier match", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const handler = createUsageAckHttpHandler(ackStore);

    const firstResponse = createResponse();
    await handler(
      {
        body: createAck({
          sufficiency: "needs_followup"
        })
      } as never,
      firstResponse as never
    );

    const secondResponse = createResponse();
    await handler(
      {
        body: createAck({
          sufficiency: "sufficient"
        })
      } as never,
      secondResponse as never
    );

    assert.deepEqual(firstResponse.body, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
    assert.deepEqual(secondResponse.body, firstResponse.body);
    assert.equal(ackStore.size(), 1);
    assert.equal(ackStore.get("checkpoint-1")?.sufficiency, "needs_followup");
  } finally {
    db.close();
  }
});

test("HTTP handler still stores the ack when checkpoint_store does not know the id", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const checkpointStore = createCheckpointStore(db);
    const handler = createUsageAckHttpHandler(ackStore, checkpointStore);
    const response = createResponse();

    await handler({ body: createAck() } as never, response as never);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ack: true });
    assert.equal(ackStore.size(), 1);
  } finally {
    db.close();
  }
});

test("checkpoint_store omission skips digest validation and preserves existing ack behavior", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const handler = createUsageAckHttpHandler(ackStore);
    const response = createResponse();

    await handler(
      {
        body: createAck({
          bundle_digest: "bundle-received",
          sufficiency: "needs_followup"
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
    assert.equal(ackStore.size(), 1);
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to bundle_digest_mismatch and skips persistence when checkpoint digest differs", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const checkpointStore = createCheckpointStore(db);
    checkpointStore.put({
      checkpoint_id: "checkpoint-1",
      bundle_digest: "bundle-expected",
      intent: "lookup",
      surface: "codex",
      session_id: "session-1",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory",
      query_hash: "query-1",
      mode: "L1",
      profile_used: "lookup",
      ranker_version: "v1.0",
      record_ids: ["wiki:wiki-1"]
    });
    const handler = createUsageAckHttpHandler(ackStore, checkpointStore);
    const response = createResponse();

    await handler(
      {
        body: createAck({
          bundle_digest: "bundle-received",
          sufficiency: "needs_followup"
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ack: true,
      degraded: "bundle_digest_mismatch"
    });
    assert.equal(ackStore.size(), 0);
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to ack_already_recorded when the same checkpoint changes host_tier", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const handler = createUsageAckHttpHandler(ackStore);
    await handler({ body: createAck() } as never, createResponse() as never);

    const response = createResponse();
    await handler(
      {
        body: createAck({
          host_tier: "T3"
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ack: true,
      degraded: "ack_already_recorded"
    });
    assert.equal(ackStore.size(), 1);
    assert.equal(ackStore.get("checkpoint-1")?.host_tier, "T2");
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to usage_ack_unavailable when no ack store is configured", async () => {
  const handler = createUsageAckHttpHandler(undefined);
  const response = createResponse();

  await handler({ body: createAck() } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ack: true,
    degraded: "usage_ack_unavailable"
  });
});

test("HTTP handler degrades to persist_failed when ack persistence throws", async () => {
  const handler = createUsageAckHttpHandler(createThrowingAckStore());
  const response = createResponse();

  await handler({ body: createAck() } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ack: true,
    degraded: "persist_failed"
  });
});

test("MCP tool invoke degrades to usage_ack_unavailable when no ack store is configured", async () => {
  const tool = createUsageAckMcpTool(undefined);

  await assert.doesNotReject(async () => {
    const result = await tool.invoke(createAck());

    assert.deepEqual(result, {
      ack: true,
      degraded: "usage_ack_unavailable"
    });
  });
});

test("MCP tool invoke degrades to persist_failed when ack persistence throws", async () => {
  const tool = createUsageAckMcpTool(createThrowingAckStore());

  await assert.doesNotReject(async () => {
    const result = await tool.invoke(createAck());

    assert.deepEqual(result, {
      ack: true,
      degraded: "persist_failed"
    });
  });
});

test("MCP retries preserve an originally submitted needs_external response without degraded metadata", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db, { now: () => 1_000 });
    const tool = createUsageAckMcpTool(ackStore);

    const first = await tool.invoke(
      createAck({
        sufficiency: "needs_external"
      })
    );
    const retry = await tool.invoke(
      createAck({
        sufficiency: "needs_external",
        evidence: "more evidence later"
      })
    );

    assert.deepEqual(first, { ack: true });
    assert.deepEqual(retry, { ack: true });
    assert.equal(ackStore.get("checkpoint-1")?.sufficiency, "needs_external");
    assert.equal(ackStore.get("checkpoint-1")?.guard_overridden, false);
  } finally {
    db.close();
  }
});

test("MCP retries rebuild the stored loop-guard response after override", async () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const ackStore = createAckStore(db, { now: () => now });
    const checkpointStore = createCheckpointStore(db, { now: () => now });
    checkpointStore.put({
      checkpoint_id: "checkpoint-1",
      bundle_digest: "bundle-checkpoint-1",
      intent: "lookup",
      surface: "codex",
      session_id: "session-loop",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory",
      query_hash: "query-1",
      mode: "L1",
      profile_used: "lookup",
      ranker_version: "v1.0",
      record_ids: ["wiki:wiki-1"]
    });
    checkpointStore.put({
      checkpoint_id: "checkpoint-2",
      bundle_digest: "bundle-checkpoint-2",
      intent: "lookup",
      surface: "codex",
      session_id: "session-loop",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory",
      query_hash: "query-2",
      mode: "L1",
      profile_used: "lookup",
      ranker_version: "v1.0",
      record_ids: ["wiki:wiki-2"]
    });
    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => now);

    await tool.invoke(
      createAck({
        checkpoint_id: "checkpoint-1",
        bundle_digest: "bundle-checkpoint-1",
        sufficiency: "needs_followup"
      })
    );
    now += 1;
    const first = await tool.invoke(
      createAck({
        checkpoint_id: "checkpoint-2",
        bundle_digest: "bundle-checkpoint-2",
        sufficiency: "needs_followup"
      })
    );
    now += 1;
    const retry = await tool.invoke(
      createAck({
        checkpoint_id: "checkpoint-2",
        bundle_digest: "bundle-checkpoint-2",
        sufficiency: "needs_followup",
        evidence: "retry"
      })
    );

    assert.deepEqual(first, {
      ack: true,
      degraded: "needs_followup_loop_limit",
      forced_sufficiency: "needs_external"
    });
    assert.deepEqual(retry, first);
    assert.equal(ackStore.get("checkpoint-2")?.sufficiency, "needs_external");
    assert.equal(ackStore.get("checkpoint-2")?.guard_overridden, true);
  } finally {
    db.close();
  }
});

test("conflict responses do not trigger overrideSufficiency", async () => {
  const insertedRecord = {
    checkpoint_id: "checkpoint-1",
    bundle_digest: "bundle-1",
    sufficiency: "needs_followup" as const,
    host_tier: "T2" as const,
    evidence: "because",
    turn_elapsed_ms: 125,
    session_id: "session-1",
    acked_at: 1_000,
    guard_overridden: false
  };
  let overrideCalls = 0;
  const ackStore: AckStore = {
    put(): AckPutResult {
      return {
        record: insertedRecord,
        status: "conflict"
      };
    },
    get() {
      return insertedRecord;
    },
    overrideSufficiency() {
      overrideCalls += 1;
    },
    countRecent() {
      return 1;
    },
    size() {
      return 1;
    }
  };
  const checkpointStore = {
    put() {
      throw new Error("not used");
    },
    get() {
      return {
        checkpoint_id: "checkpoint-1",
        bundle_digest: "bundle-1",
        intent: "lookup" as const,
        surface: "codex" as const,
        session_id: "session-1",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory",
        query_hash: "query-1",
        mode: "L1" as const,
        profile_used: "lookup",
        ranker_version: "v1.0",
        record_ids: ["wiki:wiki-1"],
        created_at: 1_000,
        ttl_expires_at: 2_000
      };
    },
    evictExpired() {
      return 0;
    },
    size() {
      return 1;
    }
  };
  const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => 1_000);

  const result = await tool.invoke(
    createAck({
      sufficiency: "needs_followup"
    })
  );

  assert.deepEqual(result, {
    ack: true,
    degraded: "ack_already_recorded"
  });
  assert.equal(overrideCalls, 0);
});
