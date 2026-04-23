import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  createFeedbackUsageAckHttpHandler,
  createFeedbackUsageAckMcpTool,
  createFeedbackUsageAckStore
} from "../feedback/usage-ack-handler.js";
import { MetricsCollector } from "../monitoring/metrics.js";
import { createVegaMetrics } from "../monitoring/vega-metrics.js";

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

const createFeedbackAck = (overrides: Partial<{
  memory_id: string;
  ack_type: "accepted" | "rejected" | "reranked";
  context: Record<string, unknown>;
  session_id: string;
  event_id: string;
  ts: string;
}> = {}) => ({
  memory_id: "memory-1",
  ack_type: "accepted" as const,
  context: {
    query: "phase7 local code status",
    intent: "lookup",
    surface: "codex"
  },
  session_id: "session-1",
  event_id: "11111111-1111-4111-8111-111111111111",
  ts: "2026-04-23T08:00:00.000Z",
  ...overrides
});

test("feedback usage.ack stores memory feedback and updates bounded counters", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createFeedbackUsageAckStore(db, { now: () => 2_000 });
    const tool = createFeedbackUsageAckMcpTool(store);

    const result = await tool.invoke(createFeedbackAck());

    assert.deepEqual(result, {
      ack: true,
      event_id: "11111111-1111-4111-8111-111111111111",
      memory_id: "memory-1",
      idempotent: false,
      counters: {
        accepted: 1,
        rejected: 0,
        reranked: 0,
        total: 1
      },
      bounded_surfaces: ["retrieval_prior", "ranking_bias", "value_judgment_stats"]
    });
    assert.equal(store.getByEventId("11111111-1111-4111-8111-111111111111")?.context.query, "phase7 local code status");
  } finally {
    db.close();
  }
});

test("feedback usage.ack MCP tool exposes the P7-011 input schema", () => {
  const tool = createFeedbackUsageAckMcpTool(undefined);
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };

  assert.ok(schema.properties?.memory_id);
  assert.ok(schema.properties?.ack_type);
  assert.ok(schema.properties?.event_id);
});

test("feedback usage.ack dedupes repeated event_id without double-counting", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createFeedbackUsageAckStore(db, { now: () => 2_000 });
    const tool = createFeedbackUsageAckMcpTool(store);

    await tool.invoke(createFeedbackAck());
    const second = await tool.invoke(createFeedbackAck({ ack_type: "rejected" }));

    assert.equal(second.idempotent, true);
    assert.deepEqual(second.counters, {
      accepted: 1,
      rejected: 0,
      reranked: 0,
      total: 1
    });
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("feedback usage.ack metrics count inserted ack types and degraded rejects", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    const metrics = createVegaMetrics(collector, db);
    const store = createFeedbackUsageAckStore(db, { now: () => 2_000 });
    const tool = createFeedbackUsageAckMcpTool(store, metrics);

    await tool.invoke(createFeedbackAck({ ack_type: "reranked" }));
    await createFeedbackUsageAckMcpTool(undefined, metrics).invoke(createFeedbackAck({
      event_id: "22222222-2222-4222-8222-222222222222"
    }));

    const rendered = await collector.getMetrics();

    assert.match(rendered, /vega_usage_feedback_ack_total\{ack_type="reranked"\} 1/);
    assert.match(
      rendered,
      /vega_usage_feedback_ack_rejected_total\{reason="usage_feedback_ack_unavailable"\} 1/
    );
  } finally {
    db.close();
  }
});

test("feedback usage.ack HTTP handler validates the P7-011 input shape", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createFeedbackUsageAckHttpHandler(createFeedbackUsageAckStore(db));
    const response = createResponse();

    await handler({ body: { ...createFeedbackAck(), event_id: "not-a-uuid" } } as never, response as never);

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, {
      error: "ValidationError",
      detail: "event_id: Invalid UUID"
    });
  } finally {
    db.close();
  }
});

test("feedback usage.ack HTTP handler degrades when the feedback store is unavailable", async () => {
  const handler = createFeedbackUsageAckHttpHandler(undefined);
  const response = createResponse();

  await handler({ body: createFeedbackAck() } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ack: true,
    event_id: "11111111-1111-4111-8111-111111111111",
    memory_id: "memory-1",
    idempotent: false,
    counters: {
      accepted: 0,
      rejected: 0,
      reranked: 0,
      total: 0
    },
    bounded_surfaces: ["retrieval_prior", "ranking_bias", "value_judgment_stats"],
    degraded: "usage_feedback_ack_unavailable"
  });
});
