import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { VegaConfig } from "../../config.js";
import {
  buildBenchmarkMarkdown,
  loadLatestBenchmarkReport,
  writeBenchmarkArtifacts
} from "../../benchmark/report.js";
import { runBenchmarkSuite } from "../../benchmark/runner.js";

const createConfig = (dbPath: string): VegaConfig => ({
  dbPath,
  ollamaBaseUrl: "http://localhost:99999",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  dbEncryption: false,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
});

test("benchmark runner persists JSON and markdown artifacts with trend history", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-benchmark-runner-"));
  const config = createConfig(join(tempDir, "memory.db"));

  try {
    const first = await runBenchmarkSuite(config);
    writeBenchmarkArtifacts(first);

    assert.equal(first.summary.total_checks > 0, true);
    assert.equal(first.suites.token.session_start.L0.token_estimate > 0, true);
    assert.equal(first.suites.recall_quality.recall_at_10 >= first.suites.recall_quality.recall_at_5, true);
    assert.equal(first.suites.latency.recall["1000"].memory_count, 1000);
    assert.equal(existsSync(first.files.json), true);
    assert.equal(existsSync(first.files.markdown), true);

    const second = await runBenchmarkSuite(config);
    writeBenchmarkArtifacts(second);

    assert.equal(second.trend?.previous_run_id, first.run_id);

    const latest = loadLatestBenchmarkReport(config);
    assert.ok(latest);
    assert.equal(latest.run_id, second.run_id);
    assert.match(buildBenchmarkMarkdown(latest), /Vega Memory Benchmark Report/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
