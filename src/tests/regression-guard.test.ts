import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { RegressionGuard } from "../core/regression-guard.js";
import type { Memory, SearchResult } from "../core/types.js";
import { Repository } from "../db/repository.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
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
  telegramChatId: undefined,
  regressionGuard: {
    maxSessionStartToken: 2500,
    maxRecallLatencyMs: 500,
    minRecallAvgSimilarity: 0.4,
    maxTopKInflationRatio: 0.3
  }
};

const createMemory = (id: string, overrides: Partial<Memory> = {}): Memory => {
  const { summary = null, ...rest } = overrides;

  return {
    id,
    type: "decision",
    project: "vega",
    title: id,
    content: `content for ${id}`,
    summary,
    embedding: null,
    importance: 0.7,
    source: "explicit",
    tags: [],
    created_at: "2026-04-09T00:00:00.000Z",
    updated_at: "2026-04-09T00:00:00.000Z",
    accessed_at: "2026-04-09T00:00:00.000Z",
    access_count: 0,
    status: "active",
    verified: "verified",
    scope: "project",
    accessed_projects: ["vega"],
    ...rest
  };
};

const createSearchResult = (id: string, similarity: number): SearchResult => ({
  memory: createMemory(id, {
    content: `${id} `.repeat(40)
  }),
  similarity,
  finalScore: similarity
});

test("RegressionGuard detects session_start token threshold breaches and records metrics", () => {
  const repository = new Repository(":memory:");
  const guard = new RegressionGuard(repository, baseConfig);

  try {
    const violations = guard.recordSessionStart("standard", 2601, 120, {
      memoryCount: 42,
      resultCount: 7
    });
    const log = repository.getRecentPerformanceLogs(1, "session_start")[0];

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.metric, "max_session_start_token");
    assert.ok(log);
    assert.equal(log.mode, "standard");
    assert.equal(log.token_estimate, 2601);
    assert.equal(log.token_budget, 2000);
    assert.equal(log.token_budget_utilization, 2601 / 2000);
    assert.equal(log.memory_count, 42);
    assert.equal(log.result_count, 7);
  } finally {
    repository.close();
  }
});

test("RegressionGuard records recall metrics and warns on latency, similarity, and inflation regressions", () => {
  const repository = new Repository(":memory:");
  const guard = new RegressionGuard(repository, baseConfig);
  const results = [
    createSearchResult("low-a", 0.2),
    createSearchResult("low-b", 0.3),
    createSearchResult("high", 0.85)
  ];

  try {
    const violations = guard.recordRecall(3, 0.3, 640, {
      operation: "recall",
      memoryCount: 12,
      resultTypes: ["decision", "decision", "decision"],
      bm25ResultCount: 1,
      tokenEstimate: guard.calculateRecallResultTokenEstimate(results),
      topKInflationRatio: guard.calculateTopKInflationRatio(results),
      embeddingLatencyMs: 85
    });
    const log = repository.getRecentPerformanceLogs(1, "recall")[0];

    assert.deepEqual(
      violations.map((violation) => violation.metric).sort(),
      [
        "max_recall_latency_ms",
        "max_top_k_inflation_ratio",
        "min_recall_avg_similarity"
      ]
    );
    assert.ok(log);
    assert.equal(log.embedding_latency_ms, 85);
    assert.equal(log.bm25_result_count, 1);
    assert.equal(log.result_count, 3);
    assert.equal(log.top_k_inflation_ratio, 2 / 3);
    assert.ok((log.token_estimate ?? 0) > 0);
  } finally {
    repository.close();
  }
});

test("RegressionGuard generates aggregate reports for token, latency, and recall quality metrics", () => {
  const repository = new Repository(":memory:");
  const guard = new RegressionGuard(repository, baseConfig);

  try {
    repository.logPerformance({
      timestamp: "2026-04-09T00:00:01.000Z",
      operation: "session_start",
      latency_ms: 100,
      memory_count: 5,
      result_count: 3,
      result_types: [],
      bm25_result_count: 0,
      mode: "light",
      token_estimate: 400,
      token_budget: 2000,
      token_budget_utilization: 0.2
    });
    repository.logPerformance({
      timestamp: "2026-04-09T00:00:02.000Z",
      operation: "session_start",
      latency_ms: 140,
      memory_count: 8,
      result_count: 6,
      result_types: [],
      bm25_result_count: 0,
      mode: "standard",
      token_estimate: 1100,
      token_budget: 2000,
      token_budget_utilization: 0.55
    });
    repository.logPerformance({
      timestamp: "2026-04-09T00:00:03.000Z",
      operation: "recall",
      latency_ms: 180,
      memory_count: 12,
      result_count: 4,
      avg_similarity: 0.72,
      result_types: ["decision", "pitfall"],
      bm25_result_count: 2,
      token_estimate: 320,
      token_budget: 2000,
      token_budget_utilization: 0.16,
      top_k_inflation_ratio: 0.25,
      embedding_latency_ms: 40
    });
    repository.logPerformance({
      timestamp: "2026-04-09T00:00:04.000Z",
      operation: "recall_stream",
      latency_ms: 220,
      memory_count: 12,
      result_count: 2,
      avg_similarity: 0.68,
      result_types: ["decision"],
      bm25_result_count: 1,
      token_estimate: 180,
      token_budget: 2000,
      token_budget_utilization: 0.09,
      top_k_inflation_ratio: 0,
      embedding_latency_ms: 35
    });

    const report = guard.getReport();

    assert.equal(report.status, "ok");
    assert.equal(report.token.session_start_token_estimate.count, 2);
    assert.equal(report.token.session_start_token_by_mode.light.count, 1);
    assert.equal(report.token.session_start_token_by_mode.standard.count, 1);
    assert.equal(report.token.recall_result_token_estimate.count, 2);
    assert.equal(report.latency.session_start_latency_ms.count, 2);
    assert.equal(report.latency.recall_latency_ms.count, 2);
    assert.equal(report.latency.embedding_latency_ms.count, 2);
    assert.equal(report.recall_quality.recall_result_count.count, 2);
    assert.equal(report.recall_quality.recall_avg_similarity.count, 2);
    assert.equal(report.recall_quality.recall_top_k_inflation.count, 2);
    assert.equal(report.recall_quality.evidence_pull_rate, 0);
    assert.equal(report.violations.length, 0);
  } finally {
    repository.close();
  }
});
