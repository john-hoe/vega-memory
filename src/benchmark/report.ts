import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { VegaConfig } from "../config.js";
import { getDataDir } from "../core/health.js";
import type { SessionStartCanonicalMode } from "../core/types.js";

import type {
  BenchmarkFiles,
  BenchmarkPercentileSummary,
  BenchmarkReport,
  BenchmarkReportWithoutComputed,
  BenchmarkThresholdCheck,
  BenchmarkTrend,
  BenchmarkTrendComparison
} from "./types.js";

const round = (value: number): number => Number(value.toFixed(3));

const percentile = (sorted: number[], rank: number): number => {
  if (sorted.length === 1) {
    return round(sorted[0]!);
  }

  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1)
  );

  return round(sorted[index]!);
};

const buildCheck = (
  id: string,
  suite: BenchmarkThresholdCheck["suite"],
  label: string,
  actual: number,
  threshold: number,
  comparator: BenchmarkThresholdCheck["comparator"],
  unit: string
): BenchmarkThresholdCheck => ({
  id,
  suite,
  label,
  actual: round(actual),
  threshold: round(threshold),
  comparator,
  unit,
  passed:
    comparator === "<="
      ? actual <= threshold
      : comparator === ">="
        ? actual >= threshold
        : actual === threshold
});

const toDisplayValue = (value: number, unit: string): string =>
  `${round(value)}${unit ? ` ${unit}` : ""}`;

export const BENCHMARK_SESSION_TOKEN_MODES = ["L0", "L1", "L2"] as const satisfies ReadonlyArray<
  Exclude<SessionStartCanonicalMode, "L3">
>;
export const BENCHMARK_SESSION_LATENCY_MODES = [
  "L0",
  "L1",
  "L2",
  "L3"
] as const satisfies ReadonlyArray<SessionStartCanonicalMode>;
export const BENCHMARK_RECALL_SCALES = [100, 500, 1000] as const;

export const summarizeLatency = (values: number[]): BenchmarkPercentileSummary => {
  if (values.length === 0) {
    throw new Error("Cannot summarize empty benchmark samples");
  }

  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    sample_count: sorted.length,
    average_ms: round(total / sorted.length),
    min_ms: round(sorted[0]!),
    max_ms: round(sorted[sorted.length - 1]!),
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99)
  };
};

export const getBenchmarkOutputDir = (config: VegaConfig): string =>
  join(getDataDir(config), "benchmarks");

export const createBenchmarkRunId = (timestamp = new Date()): string =>
  timestamp.toISOString().replace(/[-:]/g, "").replace(".", "");

export const getBenchmarkFiles = (
  config: VegaConfig,
  runId: string
): BenchmarkFiles & { outputDir: string } => {
  const outputDir = getBenchmarkOutputDir(config);

  return {
    outputDir,
    json: join(outputDir, `benchmark-${runId}.json`),
    markdown: join(outputDir, `benchmark-${runId}.md`)
  };
};

const listBenchmarkJsonFiles = (outputDir: string): string[] => {
  if (!existsSync(outputDir)) {
    return [];
  }

  return readdirSync(outputDir)
    .filter((entry) => /^benchmark-\d{8}T\d{6}\d{3}Z\.json$/u.test(entry))
    .sort()
    .map((entry) => join(outputDir, entry));
};

export const loadLatestBenchmarkReport = (config: VegaConfig): BenchmarkReport | null => {
  const files = listBenchmarkJsonFiles(getBenchmarkOutputDir(config));
  const latest = files[files.length - 1];

  if (!latest) {
    return null;
  }

  return JSON.parse(readFileSync(latest, "utf8")) as BenchmarkReport;
};

export const loadPreviousBenchmarkReport = (
  config: VegaConfig,
  currentRunId: string
): BenchmarkReport | null => {
  const files = listBenchmarkJsonFiles(getBenchmarkOutputDir(config))
    .filter((path) => !path.endsWith(`benchmark-${currentRunId}.json`));
  const previous = files[files.length - 1];

  if (!previous) {
    return null;
  }

  return JSON.parse(readFileSync(previous, "utf8")) as BenchmarkReport;
};

const extractTrendMetrics = (
  report: BenchmarkReport
): Array<{ id: string; label: string; value: number; unit: string }> => {
  const metrics: Array<{ id: string; label: string; value: number; unit: string }> = [];

  for (const mode of BENCHMARK_SESSION_TOKEN_MODES) {
    metrics.push({
      id: `token.session_start.${mode}`,
      label: `Token ${mode}`,
      value: report.suites.token.session_start[mode].token_estimate,
      unit: "tokens"
    });
  }

  metrics.push({
    id: "token.recall_result",
    label: "Recall Result Tokens",
    value: report.suites.token.recall_result.token_estimate,
    unit: "tokens"
  });
  metrics.push({
    id: "recall_quality.recall_at_5",
    label: "Recall@5",
    value: report.suites.recall_quality.recall_at_5,
    unit: "ratio"
  });
  metrics.push({
    id: "recall_quality.recall_at_10",
    label: "Recall@10",
    value: report.suites.recall_quality.recall_at_10,
    unit: "ratio"
  });
  metrics.push({
    id: "recall_quality.precision_delta_at_5",
    label: "Topic Precision Delta@5",
    value: report.suites.recall_quality.precision_delta_at_5,
    unit: "ratio"
  });
  metrics.push({
    id: "recall_quality.fact_claim_accuracy",
    label: "Fact Claim Accuracy",
    value: report.suites.recall_quality.fact_claim_accuracy,
    unit: "ratio"
  });

  for (const mode of BENCHMARK_SESSION_LATENCY_MODES) {
    metrics.push({
      id: `latency.session_start.${mode}.p95`,
      label: `Session ${mode} P95`,
      value: report.suites.latency.session_start[mode].p95_ms,
      unit: "ms"
    });
  }

  for (const scale of BENCHMARK_RECALL_SCALES) {
    metrics.push({
      id: `latency.recall.${scale}.p95`,
      label: `Recall ${scale} P95`,
      value: report.suites.latency.recall[String(scale)].p95_ms,
      unit: "ms"
    });
  }

  metrics.push({
    id: "latency.deep_recall.p95",
    label: "Deep Recall P95",
    value: report.suites.latency.deep_recall.p95_ms,
    unit: "ms"
  });

  return metrics;
};

export const buildBenchmarkTrend = (
  previous: BenchmarkReport | null,
  current: BenchmarkReport
): BenchmarkTrend | undefined => {
  if (!previous) {
    return undefined;
  }

  const previousById = new Map(
    extractTrendMetrics(previous).map((metric) => [metric.id, metric] as const)
  );
  const comparisons: BenchmarkTrendComparison[] = [];

  for (const metric of extractTrendMetrics(current)) {
    const prior = previousById.get(metric.id);

    if (!prior) {
      continue;
    }

    const delta = metric.value - prior.value;
    comparisons.push({
      id: metric.id,
      label: metric.label,
      previous: round(prior.value),
      current: round(metric.value),
      delta: round(delta),
      delta_pct: prior.value === 0 ? null : round((delta / prior.value) * 100),
      unit: metric.unit
    });
  }

  return {
    previous_run_id: previous.run_id,
    comparisons
  };
};

export const buildBenchmarkChecks = (
  report: BenchmarkReportWithoutComputed,
  config: VegaConfig
): BenchmarkThresholdCheck[] => {
  const recallLatencyThreshold = config.regressionGuard?.maxRecallLatencyMs ?? 500;
  const sessionStartTokenThreshold = config.regressionGuard?.maxSessionStartToken ?? 2500;
  const checks: BenchmarkThresholdCheck[] = [
    buildCheck(
      "token.session_start.L0.max",
      "token",
      "L0 session token budget",
      report.suites.token.session_start.L0.token_estimate,
      50,
      "<=",
      "tokens"
    ),
    buildCheck(
      "token.session_start.L1.max",
      "token",
      "L1 session token budget",
      report.suites.token.session_start.L1.token_estimate,
      Math.floor(config.tokenBudget * 0.25),
      "<=",
      "tokens"
    ),
    buildCheck(
      "token.session_start.L2.max",
      "token",
      "L2 session token budget",
      report.suites.token.session_start.L2.token_estimate,
      sessionStartTokenThreshold,
      "<=",
      "tokens"
    ),
    buildCheck(
      "token.session_start.L1.delta",
      "token",
      "L1 exceeds L0 token usage",
      report.suites.token.session_start.L1.token_estimate -
        report.suites.token.session_start.L0.token_estimate,
      1,
      ">=",
      "tokens"
    ),
    buildCheck(
      "token.session_start.L2.delta",
      "token",
      "L2 exceeds L1 token usage",
      report.suites.token.session_start.L2.token_estimate -
        report.suites.token.session_start.L1.token_estimate,
      1,
      ">=",
      "tokens"
    ),
    buildCheck(
      "token.recall_result.max",
      "token",
      "Recall result token estimate",
      report.suites.token.recall_result.token_estimate,
      config.tokenBudget,
      "<=",
      "tokens"
    ),
    buildCheck(
      "recall_quality.recall_at_5.min",
      "recall_quality",
      "Recall@5 hit rate",
      report.suites.recall_quality.recall_at_5,
      0.8,
      ">=",
      "ratio"
    ),
    buildCheck(
      "recall_quality.recall_at_10.min",
      "recall_quality",
      "Recall@10 hit rate",
      report.suites.recall_quality.recall_at_10,
      0.9,
      ">=",
      "ratio"
    ),
    buildCheck(
      "recall_quality.precision_delta_at_5.min",
      "recall_quality",
      "Topic precision delta@5",
      report.suites.recall_quality.precision_delta_at_5,
      0,
      ">=",
      "ratio"
    ),
    buildCheck(
      "recall_quality.precision_delta_at_10.min",
      "recall_quality",
      "Topic precision delta@10",
      report.suites.recall_quality.precision_delta_at_10,
      0,
      ">=",
      "ratio"
    ),
    buildCheck(
      "recall_quality.fact_claim_accuracy.eq",
      "recall_quality",
      "Fact claim as_of accuracy",
      report.suites.recall_quality.fact_claim_accuracy,
      1,
      "==",
      "ratio"
    ),
    buildCheck(
      "latency.session_start.L0.p95",
      "latency",
      "L0 session p95",
      report.suites.latency.session_start.L0.p95_ms,
      100,
      "<=",
      "ms"
    ),
    buildCheck(
      "latency.session_start.L1.p95",
      "latency",
      "L1 session p95",
      report.suites.latency.session_start.L1.p95_ms,
      150,
      "<=",
      "ms"
    ),
    buildCheck(
      "latency.session_start.L2.p95",
      "latency",
      "L2 session p95",
      report.suites.latency.session_start.L2.p95_ms,
      250,
      "<=",
      "ms"
    ),
    buildCheck(
      "latency.session_start.L3.p95",
      "latency",
      "L3 session p95",
      report.suites.latency.session_start.L3.p95_ms,
      350,
      "<=",
      "ms"
    ),
    buildCheck(
      "latency.recall.100.p95",
      "latency",
      "Recall 100 memories p95",
      report.suites.latency.recall["100"].p95_ms,
      Math.min(recallLatencyThreshold, 250),
      "<=",
      "ms"
    ),
    buildCheck(
      "latency.recall.500.p95",
      "latency",
      "Recall 500 memories p95",
      report.suites.latency.recall["500"].p95_ms,
      Math.max(recallLatencyThreshold, 350),
      "<=",
      "ms"
    ),
    buildCheck(
      "latency.recall.1000.p95",
      "latency",
      "Recall 1000 memories p95",
      report.suites.latency.recall["1000"].p95_ms,
      Math.max(recallLatencyThreshold, 500),
      "<=",
      "ms"
    ),
    buildCheck(
      "latency.deep_recall.p95",
      "latency",
      "Deep recall p95",
      report.suites.latency.deep_recall.p95_ms,
      200,
      "<=",
      "ms"
    )
  ];

  return checks;
};

export const buildBenchmarkSummary = (
  checks: BenchmarkThresholdCheck[]
): BenchmarkReport["summary"] => {
  const passedChecks = checks.filter((check) => check.passed).length;

  return {
    passed: passedChecks === checks.length,
    total_checks: checks.length,
    passed_checks: passedChecks,
    failed_checks: checks.length - passedChecks
  };
};

export const buildBenchmarkMarkdown = (report: BenchmarkReport): string => {
  const lines = [
    "# Vega Memory Benchmark Report",
    "",
    `Generated: ${report.generated_at}`,
    `Run ID: ${report.run_id}`,
    `Overall: ${report.summary.passed ? "PASS" : "FAIL"} (${report.summary.passed_checks}/${report.summary.total_checks} checks)`,
    `Recall engine: ${report.environment.recall_engine}`,
    `Ollama available: ${report.environment.ollama_available}`,
    ""
  ];

  if (report.trend) {
    lines.push(`Compared to: ${report.trend.previous_run_id}`, "");
  }

  lines.push("## Checks", "");
  lines.push("| Metric | Actual | Threshold | Pass |");
  lines.push("| --- | ---: | ---: | --- |");

  for (const check of report.checks) {
    lines.push(
      `| ${check.label} | ${toDisplayValue(check.actual, check.unit)} | ${check.comparator} ${toDisplayValue(check.threshold, check.unit)} | ${check.passed ? "yes" : "no"} |`
    );
  }

  lines.push("", "## Token", "");
  lines.push("| Mode | Token Estimate | Latency (ms) | Items |");
  lines.push("| --- | ---: | ---: | ---: |");

  for (const mode of BENCHMARK_SESSION_TOKEN_MODES) {
    const measurement = report.suites.token.session_start[mode];
    lines.push(
      `| ${mode} | ${measurement.token_estimate} | ${round(measurement.latency_ms)} | ${measurement.item_count} |`
    );
  }

  lines.push("");
  lines.push(
    `Recall result: query "${report.suites.token.recall_result.query}", ${report.suites.token.recall_result.result_count} results, ${report.suites.token.recall_result.token_estimate} tokens`
  );
  lines.push("");

  lines.push("## Recall Quality", "");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Recall@5 | ${round(report.suites.recall_quality.recall_at_5)} |`);
  lines.push(`| Recall@10 | ${round(report.suites.recall_quality.recall_at_10)} |`);
  lines.push(
    `| Unfiltered Precision@5 | ${round(report.suites.recall_quality.unfiltered_precision_at_5)} |`
  );
  lines.push(
    `| Topic-filtered Precision@5 | ${round(report.suites.recall_quality.topic_filtered_precision_at_5)} |`
  );
  lines.push(
    `| Precision Delta@5 | ${round(report.suites.recall_quality.precision_delta_at_5)} |`
  );
  lines.push(
    `| Fact Claim Accuracy | ${round(report.suites.recall_quality.fact_claim_accuracy)} |`
  );
  lines.push("");

  lines.push("## Latency", "");
  lines.push("| Operation | Samples | P50 (ms) | P95 (ms) | P99 (ms) |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");

  for (const mode of BENCHMARK_SESSION_LATENCY_MODES) {
    const summary = report.suites.latency.session_start[mode];
    lines.push(
      `| session_start ${mode} | ${summary.sample_count} | ${summary.p50_ms} | ${summary.p95_ms} | ${summary.p99_ms} |`
    );
  }

  for (const scale of BENCHMARK_RECALL_SCALES) {
    const summary = report.suites.latency.recall[String(scale)];
    lines.push(
      `| recall ${scale} | ${summary.sample_count} | ${summary.p50_ms} | ${summary.p95_ms} | ${summary.p99_ms} |`
    );
  }

  lines.push(
    `| deep_recall | ${report.suites.latency.deep_recall.sample_count} | ${report.suites.latency.deep_recall.p50_ms} | ${report.suites.latency.deep_recall.p95_ms} | ${report.suites.latency.deep_recall.p99_ms} |`
  );

  if (report.trend && report.trend.comparisons.length > 0) {
    lines.push("", "## Trend", "");
    lines.push("| Metric | Previous | Current | Delta |");
    lines.push("| --- | ---: | ---: | ---: |");

    for (const comparison of report.trend.comparisons) {
      const deltaSuffix =
        comparison.delta_pct === null ? "" : ` (${round(comparison.delta_pct)}%)`;
      lines.push(
        `| ${comparison.label} | ${toDisplayValue(comparison.previous, comparison.unit)} | ${toDisplayValue(comparison.current, comparison.unit)} | ${toDisplayValue(comparison.delta, comparison.unit)}${deltaSuffix} |`
      );
    }
  }

  lines.push("");
  return lines.join("\n");
};

export const writeBenchmarkArtifacts = (report: BenchmarkReport): void => {
  mkdirSync(report.output_dir, { recursive: true });
  writeFileSync(report.files.json, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(report.files.markdown, buildBenchmarkMarkdown(report), "utf8");
};
