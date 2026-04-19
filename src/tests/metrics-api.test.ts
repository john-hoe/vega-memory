import assert from "node:assert/strict";
import test from "node:test";

import { Repository } from "../db/repository.js";
import { MetricsCollector } from "../monitoring/metrics.js";
import { createVegaMetrics } from "../monitoring/vega-metrics.js";

test("Batch 10a metric families registered with HELP and TYPE lines", async () => {
  const db = new Repository(":memory:");

  try {
    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    createVegaMetrics(collector, db.db);

    const rendered = await collector.getMetrics();

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
      assert.match(rendered, new RegExp(`# HELP ${name} `));
      assert.match(rendered, new RegExp(`# TYPE ${name} ${type}`));
    }
  } finally {
    db.close();
  }
});
