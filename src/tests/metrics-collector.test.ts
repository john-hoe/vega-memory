import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { RAW_INBOX_TABLE, applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { MetricsCollector } from "../monitoring/metrics.js";
import { createVegaMetrics } from "../monitoring/vega-metrics.js";

function assertMetricFamily(metrics: string, name: string, type: "counter" | "gauge"): void {
  assert.match(metrics, new RegExp(`# HELP ${name} `));
  assert.match(metrics, new RegExp(`# TYPE ${name} ${type}`));
}

function insertRawInboxRow(
  db: SQLiteAdapter,
  {
    event_id,
    event_type,
    received_at
  }: {
    event_id: string;
    event_type: "message" | "tool_call" | "tool_result" | "decision" | "state_change";
    received_at: string;
  }
): void {
  db.run(
    `INSERT INTO ${RAW_INBOX_TABLE} (
      schema_version,
      event_id,
      surface,
      session_id,
      thread_id,
      project,
      cwd,
      host_timestamp,
      role,
      event_type,
      payload_json,
      safety_json,
      source_kind,
      artifacts_json,
      received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "1.0",
    event_id,
    "codex",
    "session-1",
    "thread-1",
    "vega-memory",
    "/Users/johnmacmini/workspace/vega-memory",
    received_at,
    "assistant",
    event_type,
    JSON.stringify({ text: event_type }),
    JSON.stringify({ redacted: false, categories: [] }),
    "vega_memory",
    "[]",
    received_at
  );
}

test("createVegaMetrics registers all vega metric families and scrapes raw inbox gauges without empty placeholder series", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });

    createVegaMetrics(collector, db);

    const initialMetrics = await collector.getMetrics();

    for (const [name, type] of [
      ["vega_retrieval_calls_total", "counter"],
      ["vega_retrieval_nonempty_total", "counter"],
      ["vega_usage_ack_total", "counter"],
      ["vega_usage_followup_loop_override_total", "counter"],
      ["vega_circuit_breaker_state", "gauge"],
      ["vega_circuit_breaker_trips_total", "counter"],
      ["vega_raw_inbox_rows", "gauge"],
      ["vega_raw_inbox_oldest_age_seconds", "gauge"]
    ] as const) {
      assertMetricFamily(initialMetrics, name, type);
    }

    assert.equal(initialMetrics.includes('vega_raw_inbox_rows{event_type='), false);
    assert.equal(initialMetrics.includes('vega_raw_inbox_oldest_age_seconds{event_type='), false);
    assert.equal(initialMetrics.includes('event_type=""'), false);

    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date(Date.now() - 15_000).toISOString();

    insertRawInboxRow(db, {
      event_id: "11111111-1111-4111-8111-111111111111",
      event_type: "message",
      received_at: older
    });
    insertRawInboxRow(db, {
      event_id: "22222222-2222-4222-8222-222222222222",
      event_type: "message",
      received_at: newer
    });
    insertRawInboxRow(db, {
      event_id: "33333333-3333-4333-8333-333333333333",
      event_type: "tool_call",
      received_at: newer
    });

    const scrapedMetrics = await collector.getMetrics();

    assert.match(scrapedMetrics, /vega_raw_inbox_rows\{event_type="message"\} 2/);
    assert.match(scrapedMetrics, /vega_raw_inbox_rows\{event_type="tool_call"\} 1/);

    const messageAgeMatch = scrapedMetrics.match(
      /vega_raw_inbox_oldest_age_seconds\{event_type="message"\} ([0-9]+(?:\.[0-9]+)?)/u
    );
    const toolCallAgeMatch = scrapedMetrics.match(
      /vega_raw_inbox_oldest_age_seconds\{event_type="tool_call"\} ([0-9]+(?:\.[0-9]+)?)/u
    );

    assert.notEqual(messageAgeMatch, null);
    assert.notEqual(toolCallAgeMatch, null);
    assert.ok(Number(messageAgeMatch?.[1]) >= 45);
    assert.ok(Number(toolCallAgeMatch?.[1]) >= 10);
  } finally {
    db.close();
  }
});

test("createVegaMetrics coerces unknown metric label values to unknown instead of throwing", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    const metrics = createVegaMetrics(collector, db);

    metrics.recordRetrievalCall("mystery-surface" as never, "mystery-intent" as never);
    metrics.recordUsageAck("mystery-surface" as never, "mystery-sufficiency" as never, "T9" as never);
    metrics.recordLoopOverride("mystery-surface" as never);
    metrics.setCircuitState("mystery-surface" as never, "open");
    metrics.recordCircuitTrip("mystery-surface" as never, "mystery-reason" as never);

    const rendered = await collector.getMetrics();

    assert.match(rendered, /vega_retrieval_calls_total\{surface="unknown",intent="unknown"\} 1/);
    assert.match(
      rendered,
      /vega_usage_ack_total\{surface="unknown",sufficiency="unknown",host_tier="unknown"\} 1/
    );
    assert.match(rendered, /vega_usage_followup_loop_override_total\{surface="unknown"\} 1/);
    assert.match(rendered, /vega_circuit_breaker_state\{surface="unknown"\} 1/);
    assert.match(rendered, /vega_circuit_breaker_trips_total\{surface="unknown",reason="unknown"\} 1/);
  } finally {
    db.close();
  }
});
