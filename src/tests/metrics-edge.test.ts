import assert from "node:assert/strict";
import test from "node:test";

import type { IntentRequest } from "../core/contracts/intent.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { MetricsCollector } from "../monitoring/metrics.js";
import { createVegaMetrics } from "../monitoring/vega-metrics.js";
import type { SourceKind } from "../core/contracts/enums.js";
import { SourceRegistry, type SourceRecord } from "../retrieval/index.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";

function createRequest(overrides: Partial<IntentRequest> = {}): IntentRequest {
  return {
    intent: "lookup",
    mode: "L1",
    query: "vega",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    ...overrides
  };
}

class ThrowingRegistry extends SourceRegistry {
  override searchMany(
    _kinds: SourceKind[],
    _input: Parameters<SourceRegistry["searchMany"]>[1]
  ): SourceRecord[] {
    throw new Error("search failed");
  }
}

test("raw_inbox_empty_table_skips_series", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    createVegaMetrics(collector, db);

    const rendered = await collector.getMetrics();

    assert.equal(rendered.includes("vega_raw_inbox_oldest_age_seconds{"), false);
    assert.equal(rendered.includes("vega_raw_inbox_rows{"), false);
  } finally {
    db.close();
  }
});

test("retrieval_nonempty_not_incremented_on_error_path", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    const metrics = createVegaMetrics(collector, db);
    const response = new RetrievalOrchestrator({
      registry: new ThrowingRegistry(),
      metrics
    }).resolve(createRequest());

    assert.equal(response.bundle_digest, "error");

    const rendered = await collector.getMetrics();

    assert.equal(
      rendered.includes('vega_retrieval_nonempty_total{surface="codex",intent="lookup"}'),
      false
    );
  } finally {
    db.close();
  }
});
