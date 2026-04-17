import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  createAckStore,
  createCheckpointStore,
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

test("HTTP handler is idempotent and keeps the last write for the same checkpoint id", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const handler = createUsageAckHttpHandler(ackStore);

    await handler({ body: createAck() } as never, createResponse() as never);
    await handler(
      {
        body: createAck({
          bundle_digest: "bundle-2",
          sufficiency: "needs_followup"
        })
      } as never,
      createResponse() as never
    );

    assert.equal(ackStore.size(), 1);
    assert.equal(ackStore.get("checkpoint-1")?.bundle_digest, "bundle-2");
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

test("HTTP handler still stores the ack when checkpoint_store is omitted", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const ackStore = createAckStore(db);
    const handler = createUsageAckHttpHandler(ackStore);
    const response = createResponse();

    await handler({ body: createAck() } as never, response as never);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ack: true });
    assert.equal(ackStore.size(), 1);
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
