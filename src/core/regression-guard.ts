import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";

import { estimateSearchResultTokens } from "./token-estimate.js";
import type {
  MemoryType,
  PerformanceLog,
  RegressionGuardReport,
  RegressionGuardThresholds,
  RegressionGuardViolation,
  RegressionMetricSummary,
  SearchResult,
  SessionStartMode
} from "./types.js";
import { SESSION_START_MODE_VALUES } from "./types.js";

const REPORT_LIMIT = 500;

const emptySummary = (): RegressionMetricSummary => ({
  count: 0,
  latest: null,
  average: null,
  min: null,
  max: null,
  p50: null,
  p95: null,
  p99: null
});

const round = (value: number): number => Number(value.toFixed(3));

const summarize = (values: number[]): RegressionMetricSummary => {
  if (values.length === 0) {
    return emptySummary();
  }

  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (rank: number): number => {
    if (sorted.length === 1) {
      return round(sorted[0]!);
    }

    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1)
    );

    return round(sorted[index]!);
  };
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    count: sorted.length,
    latest: round(values[0]!),
    average: round(total / sorted.length),
    min: round(sorted[0]!),
    max: round(sorted[sorted.length - 1]!),
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99)
  };
};

const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

const toThresholds = (config: VegaConfig): RegressionGuardThresholds => ({
  max_session_start_token: config.regressionGuard?.maxSessionStartToken ?? 2500,
  max_recall_latency_ms: config.regressionGuard?.maxRecallLatencyMs ?? 500,
  min_recall_avg_similarity: config.regressionGuard?.minRecallAvgSimilarity ?? 0.4,
  max_top_k_inflation_ratio: config.regressionGuard?.maxTopKInflationRatio ?? 0.3
});

const toWarningMessage = (violation: RegressionGuardViolation): string =>
  `regression-guard warning: ${violation.message}`;

interface RecallRecordOptions {
  operation?: "recall" | "recall_stream";
  tenantId?: string | null;
  memoryCount?: number;
  resultTypes?: MemoryType[];
  bm25ResultCount?: number;
  tokenEstimate?: number | null;
  topKInflationRatio?: number | null;
  embeddingLatencyMs?: number | null;
}

interface SessionStartRecordOptions {
  tenantId?: string | null;
  memoryCount?: number;
  resultCount?: number;
}

export class RegressionGuard {
  private readonly thresholds: RegressionGuardThresholds;

  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {
    this.thresholds = toThresholds(config);
  }

  recordSessionStart(
    mode: SessionStartMode,
    tokenEstimate: number,
    latencyMs: number,
    options: SessionStartRecordOptions = {}
  ): RegressionGuardViolation[] {
    const tokenBudgetUtilization =
      this.config.tokenBudget > 0 ? tokenEstimate / this.config.tokenBudget : 0;

    this.repository.logPerformance({
      timestamp: new Date().toISOString(),
      tenant_id: options.tenantId ?? null,
      operation: "session_start",
      latency_ms: latencyMs,
      memory_count: options.memoryCount ?? 0,
      result_count: options.resultCount ?? 0,
      result_types: [],
      bm25_result_count: 0,
      mode,
      token_estimate: tokenEstimate,
      token_budget: this.config.tokenBudget,
      token_budget_utilization: tokenBudgetUtilization
    });

    return this.evaluateSessionStart(tokenEstimate);
  }

  recordRecall(
    resultCount: number,
    avgSimilarity: number | null,
    latencyMs: number,
    options: RecallRecordOptions = {}
  ): RegressionGuardViolation[] {
    const tokenEstimate = options.tokenEstimate ?? null;
    const tokenBudgetUtilization =
      tokenEstimate !== null && this.config.tokenBudget > 0
        ? tokenEstimate / this.config.tokenBudget
        : null;

    this.repository.logPerformance({
      timestamp: new Date().toISOString(),
      tenant_id: options.tenantId ?? null,
      operation: options.operation ?? "recall",
      latency_ms: latencyMs,
      memory_count: options.memoryCount ?? 0,
      result_count: resultCount,
      avg_similarity: avgSimilarity,
      result_types: options.resultTypes ?? [],
      bm25_result_count: options.bm25ResultCount ?? 0,
      token_estimate: tokenEstimate,
      token_budget: tokenEstimate === null ? null : this.config.tokenBudget,
      token_budget_utilization: tokenBudgetUtilization,
      top_k_inflation_ratio: options.topKInflationRatio ?? null,
      embedding_latency_ms: options.embeddingLatencyMs ?? null
    });

    return this.evaluateRecall(
      options.operation ?? "recall",
      latencyMs,
      avgSimilarity,
      options.topKInflationRatio ?? null
    );
  }

  checkThresholds(tenantId?: string | null): RegressionGuardViolation[] {
    const violations: RegressionGuardViolation[] = [];
    const latestSessionStart = this.repository.getRecentPerformanceLogs(1, "session_start", tenantId)[0];
    const latestRecall = this.repository.getRecentPerformanceLogs(
      1,
      ["recall", "recall_stream"],
      tenantId
    )[0];

    if (latestSessionStart && isFiniteNumber(latestSessionStart.token_estimate)) {
      violations.push(...this.evaluateSessionStart(latestSessionStart.token_estimate));
    }

    if (latestRecall) {
      violations.push(
        ...this.evaluateRecall(
          latestRecall.operation === "recall_stream" ? "recall_stream" : "recall",
          latestRecall.latency_ms,
          latestRecall.avg_similarity ?? null,
          latestRecall.top_k_inflation_ratio ?? null
        )
      );
    }

    return violations;
  }

  getReport(tenantId?: string | null, limit = REPORT_LIMIT): RegressionGuardReport {
    const sessionLogs = this.repository.getRecentPerformanceLogs(limit, "session_start", tenantId);
    const recallLogs = this.repository.getRecentPerformanceLogs(
      limit,
      ["recall", "recall_stream"],
      tenantId
    );
    const deepRecallLogs = this.repository.getRecentPerformanceLogs(limit, "deep_recall", tenantId);

    const sessionTokenEstimates = sessionLogs
      .map((entry) => entry.token_estimate)
      .filter(isFiniteNumber);
    const recallTokenEstimates = recallLogs
      .map((entry) => entry.token_estimate)
      .filter(isFiniteNumber);
    const sessionBudgetUtilization = sessionLogs
      .map((entry) => entry.token_budget_utilization)
      .filter(isFiniteNumber);
    const recallBudgetUtilization = recallLogs
      .map((entry) => entry.token_budget_utilization)
      .filter(isFiniteNumber);
    const sessionLatencies = sessionLogs.map((entry) => entry.latency_ms).filter(isFiniteNumber);
    const recallLatencies = recallLogs.map((entry) => entry.latency_ms).filter(isFiniteNumber);
    const embeddingLatencies = recallLogs
      .map((entry) => entry.embedding_latency_ms)
      .filter(isFiniteNumber);
    const recallResultCounts = recallLogs.map((entry) => entry.result_count).filter(isFiniteNumber);
    const recallAvgSimilarities = recallLogs
      .map((entry) => entry.avg_similarity)
      .filter(isFiniteNumber);
    const recallTopKInflation = recallLogs
      .map((entry) => entry.top_k_inflation_ratio)
      .filter(isFiniteNumber);
    const evidencePullRate =
      recallLogs.length + deepRecallLogs.length === 0
        ? 0
        : round(deepRecallLogs.length / (recallLogs.length + deepRecallLogs.length));

    const summarizeSessionMode = (mode: SessionStartMode): RegressionMetricSummary =>
      summarize(
        sessionLogs
          .filter((entry) => entry.mode === mode)
          .map((entry) => entry.token_estimate)
          .filter(isFiniteNumber)
      );

    return {
      status: this.checkThresholds(tenantId).length > 0 ? "warning" : "ok",
      thresholds: this.thresholds,
      violations: this.checkThresholds(tenantId),
      token: {
        session_start_token_estimate: summarize(sessionTokenEstimates),
        session_start_token_by_mode: Object.fromEntries(
          SESSION_START_MODE_VALUES.map((mode) => [mode, summarizeSessionMode(mode)])
        ) as Record<SessionStartMode, RegressionMetricSummary>,
        recall_result_token_estimate: summarize(recallTokenEstimates),
        token_budget_utilization: {
          session_start: summarize(sessionBudgetUtilization),
          recall: summarize(recallBudgetUtilization)
        }
      },
      latency: {
        session_start_latency_ms: summarize(sessionLatencies),
        recall_latency_ms: summarize(recallLatencies),
        embedding_latency_ms: summarize(embeddingLatencies)
      },
      recall_quality: {
        recall_result_count: summarize(recallResultCounts),
        recall_avg_similarity: summarize(recallAvgSimilarities),
        recall_top_k_inflation: summarize(recallTopKInflation),
        evidence_pull_rate: evidencePullRate
      }
    };
  }

  calculateRecallResultTokenEstimate(results: SearchResult[]): number {
    return estimateSearchResultTokens(results);
  }

  calculateTopKInflationRatio(results: SearchResult[]): number {
    if (results.length === 0) {
      return 0;
    }

    const lowScoreCount = results.filter(
      (result) => result.similarity < this.thresholds.min_recall_avg_similarity
    ).length;

    return lowScoreCount / results.length;
  }

  formatWarning(violation: RegressionGuardViolation): string {
    return toWarningMessage(violation);
  }

  private evaluateSessionStart(tokenEstimate: number): RegressionGuardViolation[] {
    if (tokenEstimate <= this.thresholds.max_session_start_token) {
      return [];
    }

    return [
      {
        metric: "max_session_start_token",
        operation: "session_start",
        actual: round(tokenEstimate),
        threshold: this.thresholds.max_session_start_token,
        message: `session_start token estimate ${round(tokenEstimate)} exceeds ${this.thresholds.max_session_start_token}`
      }
    ];
  }

  private evaluateRecall(
    operation: "recall" | "recall_stream",
    latencyMs: number,
    avgSimilarity: number | null,
    topKInflationRatio: number | null
  ): RegressionGuardViolation[] {
    const violations: RegressionGuardViolation[] = [];

    if (latencyMs > this.thresholds.max_recall_latency_ms) {
      violations.push({
        metric: "max_recall_latency_ms",
        operation,
        actual: round(latencyMs),
        threshold: this.thresholds.max_recall_latency_ms,
        message: `${operation} latency ${round(latencyMs)} ms exceeds ${this.thresholds.max_recall_latency_ms} ms`
      });
    }

    if (
      avgSimilarity !== null &&
      avgSimilarity < this.thresholds.min_recall_avg_similarity
    ) {
      violations.push({
        metric: "min_recall_avg_similarity",
        operation,
        actual: round(avgSimilarity),
        threshold: this.thresholds.min_recall_avg_similarity,
        message: `${operation} avg similarity ${round(avgSimilarity)} is below ${this.thresholds.min_recall_avg_similarity}`
      });
    }

    if (
      topKInflationRatio !== null &&
      topKInflationRatio > this.thresholds.max_top_k_inflation_ratio
    ) {
      violations.push({
        metric: "max_top_k_inflation_ratio",
        operation,
        actual: round(topKInflationRatio),
        threshold: this.thresholds.max_top_k_inflation_ratio,
        message: `${operation} top-k inflation ratio ${round(topKInflationRatio)} exceeds ${this.thresholds.max_top_k_inflation_ratio}`
      });
    }

    return violations;
  }
}
