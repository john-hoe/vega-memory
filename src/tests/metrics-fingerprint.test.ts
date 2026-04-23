import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { RAW_INBOX_TABLE, applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { METRICS_FINGERPRINT } from "../monitoring/metrics-fingerprint.js";
import { MetricsCollector } from "../monitoring/metrics.js";
import { createVegaMetrics } from "../monitoring/vega-metrics.js";

interface ParsedMetricSeries {
  name: string;
  labelKeys: string[];
}

function createHarness(): {
  db: SQLiteAdapter;
  collector: MetricsCollector;
  metrics: ReturnType<typeof createVegaMetrics>;
} {
  const db = new SQLiteAdapter(":memory:");
  applyRawInboxMigration(db);

  const collector = new MetricsCollector({
    enabled: true,
    prefix: "vega"
  });

  return {
    db,
    collector,
    metrics: createVegaMetrics(collector, db)
  };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMetricSeries(rendered: string): ParsedMetricSeries[] {
  return rendered
    .split("\n")
    .filter((line) => line.startsWith("vega_"))
    .map((line) => {
      const [metricPart] = line.split(" ", 1);
      const labelsStart = metricPart.indexOf("{");

      if (labelsStart === -1) {
        return {
          name: metricPart,
          labelKeys: []
        };
      }

      const name = metricPart.slice(0, labelsStart);
      const rawLabels = metricPart.slice(labelsStart + 1, -1);

      return {
        name,
        labelKeys:
          rawLabels.length === 0
            ? []
            : rawLabels.split(",").map((entry) => entry.slice(0, entry.indexOf("=")))
      };
    });
}

test("metrics fingerprint matches the rendered HELP and TYPE catalog", async () => {
  const { db, collector } = createHarness();

  try {
    const rendered = await collector.getMetrics();

    for (const fingerprint of METRICS_FINGERPRINT) {
      assert.match(rendered, new RegExp(`# HELP ${fingerprint.name} `));
      assert.match(rendered, new RegExp(`# TYPE ${fingerprint.name} ${fingerprint.type}`));
      assert.match(rendered, new RegExp(`# HELP ${fingerprint.name} .*${escapeRegExp(fingerprint.helpFragment)}`));
    }
  } finally {
    db.close();
  }
});

test("metrics fingerprint label contracts match emitted series labels", async () => {
  const { db, collector, metrics } = createHarness();

  try {
    metrics.recordRetrievalCall("codex", "lookup");
    metrics.recordRetrievalNonempty("codex", "followup");
    metrics.recordRetrievalObservability("codex", "lookup", {
      token_efficiency: 0.5,
      source_utilization: 0.75,
      bundle_coverage: 1
    });
    metrics.recordUsageAck("codex", "needs_followup", "T2");
    metrics.recordLoopOverride("codex");
    metrics.recordMissingTrigger("unknown");
    metrics.recordSkippedBundle("codex");
    metrics.recordRepeatedFollowupInflation("codex");
    metrics.setCircuitState("codex", "open");
    metrics.recordCircuitTrip("codex", "high_followup_rate");
    insertRawInboxRow(db, {
      event_id: "11111111-1111-4111-8111-111111111111",
      event_type: "message",
      received_at: "2026-04-19T00:00:00.000Z"
    });

    const rendered = await collector.getMetrics();
    const parsedSeries = parseMetricSeries(rendered);

    for (const fingerprint of METRICS_FINGERPRINT) {
      const seriesForMetric = parsedSeries.filter((series) => series.name === fingerprint.name);

      assert.ok(seriesForMetric.length > 0, `${fingerprint.name} should render at least one sample`);

      for (const series of seriesForMetric) {
        assert.deepEqual(new Set(series.labelKeys), new Set(fingerprint.labelKeys));
      }
    }
  } finally {
    db.close();
  }
});

test("metrics fingerprint is complete for all rendered vega TYPE lines", async () => {
  const { db, collector } = createHarness();

  try {
    const rendered = await collector.getMetrics();
    const fingerprintNames = new Set(METRICS_FINGERPRINT.map((entry) => entry.name));
    const renderedTypeNames = new Set(
      rendered
        .split("\n")
        .filter((line) => line.startsWith("# TYPE vega_"))
        .map((line) => line.split(" ")[2] ?? "")
        .filter((name) => name.length > 0)
    );

    assert.deepEqual(renderedTypeNames, fingerprintNames);
  } finally {
    db.close();
  }
});
