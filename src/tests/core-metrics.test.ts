import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CORE_METRICS,
  ConsoleMetricsExporter,
  MetricsPipeline,
  type MetricSample
} from "../core/metrics/index.js";
import { FileMetricsExporter } from "../core/metrics/file-exporter.js";

class CollectingExporter {
  public readonly samples: MetricSample[] = [];

  emit(sample: MetricSample): void {
    this.samples.push(sample);
  }
}

describe("core metrics", () => {
  it("counter accumulates across multiple calls and emits the running total", () => {
    const exporter = new CollectingExporter();
    const pipeline = new MetricsPipeline([exporter]);

    pipeline.counter("promotion_precision_at_5");
    pipeline.counter("promotion_precision_at_5");

    assert.equal(exporter.samples.length, 2);
    assert.equal(exporter.samples[0]?.value, 1);
    assert.equal(exporter.samples[1]?.value, 2);
    assert.equal(exporter.samples[1]?.name, "promotion_precision_at_5");
  });

  it("gauge emits the provided value directly", () => {
    const exporter = new CollectingExporter();
    const pipeline = new MetricsPipeline([exporter]);

    pipeline.gauge("bundle_density", 0.42, { surface: "codex" });

    assert.equal(exporter.samples.length, 1);
    assert.equal(exporter.samples[0]?.value, 0.42);
    assert.deepEqual(exporter.samples[0]?.tags, { surface: "codex" });
  });

  it("CORE_METRICS exposes the five required metric definitions with descriptions", () => {
    const requiredKeys = [
      "promotion_precision_at_5",
      "bundle_density",
      "sufficiency_fp_rate",
      "checkpoint_acked_rate",
      "silent_drop_rate"
    ];

    assert.deepEqual(Object.keys(CORE_METRICS).sort(), [...requiredKeys].sort());
    for (const key of requiredKeys) {
      assert.equal(typeof CORE_METRICS[key]?.description, "string");
      assert.notEqual(CORE_METRICS[key]?.description.length, 0);
    }
  });

  it("ConsoleMetricsExporter emits without throwing", () => {
    const exporter = new ConsoleMetricsExporter();

    assert.doesNotThrow(() => {
      exporter.emit({
        name: "silent_drop_rate",
        value: 0.1,
        timestamp: "2026-04-17T00:00:00.000Z"
      });
    });
  });

  it("FileMetricsExporter appends JSONL records", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "vega-metrics-"));
    const filePath = join(tempDirectory, "nested", "metrics.jsonl");
    const exporter = new FileMetricsExporter(filePath);

    try {
      exporter.emit({
        name: "checkpoint_acked_rate",
        value: 0.99,
        tags: { surface: "cli" },
        timestamp: "2026-04-17T00:00:00.000Z"
      });

      const content = readFileSync(filePath, "utf8");
      const lines = content.trim().split("\n");

      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0] ?? "{}"), {
        name: "checkpoint_acked_rate",
        value: 0.99,
        tags: { surface: "cli" },
        timestamp: "2026-04-17T00:00:00.000Z"
      });
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
