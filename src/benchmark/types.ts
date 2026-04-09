import type { SessionStartCanonicalMode } from "../core/types.js";

export type BenchmarkRecallEngine = "hybrid" | "fts-only";

export interface BenchmarkPercentileSummary {
  sample_count: number;
  average_ms: number;
  min_ms: number;
  max_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}

export interface BenchmarkThresholdCheck {
  id: string;
  suite: "token" | "recall_quality" | "latency";
  label: string;
  actual: number;
  threshold: number;
  comparator: "<=" | ">=" | "==";
  unit: string;
  passed: boolean;
}

export interface BenchmarkTrendComparison {
  id: string;
  label: string;
  previous: number;
  current: number;
  delta: number;
  delta_pct: number | null;
  unit: string;
}

export interface BenchmarkTokenModeMeasurement {
  token_estimate: number;
  latency_ms: number;
  item_count: number;
}

export interface BenchmarkTokenModeDelta {
  from: Exclude<SessionStartCanonicalMode, "L3">;
  to: Exclude<SessionStartCanonicalMode, "L3">;
  delta_tokens: number;
  delta_ratio: number | null;
}

export interface BenchmarkRecallTokenMeasurement {
  query: string;
  engine: BenchmarkRecallEngine;
  result_count: number;
  token_estimate: number;
  top_result_ids: string[];
}

export interface BenchmarkTokenSuite {
  session_start: Record<
    Exclude<SessionStartCanonicalMode, "L3">,
    BenchmarkTokenModeMeasurement
  >;
  mode_deltas: BenchmarkTokenModeDelta[];
  recall_result: BenchmarkRecallTokenMeasurement;
}

export interface BenchmarkRecallQualityCase {
  name: string;
  query: string;
  topic?: string;
  expected_ids: string[];
  unfiltered_top10: string[];
  topic_filtered_top10?: string[];
  hits_at_5: number;
  hits_at_10: number;
  unfiltered_precision_at_5: number;
  unfiltered_precision_at_10: number;
  topic_filtered_precision_at_5?: number;
  topic_filtered_precision_at_10?: number;
}

export interface BenchmarkFactClaimCase {
  name: string;
  timestamp: string;
  subject: string;
  predicate: string;
  expected_values: string[];
  actual_values: string[];
  passed: boolean;
}

export interface BenchmarkRecallQualitySuite {
  recall_at_5: number;
  recall_at_10: number;
  unfiltered_precision_at_5: number;
  unfiltered_precision_at_10: number;
  topic_filtered_precision_at_5: number;
  topic_filtered_precision_at_10: number;
  precision_delta_at_5: number;
  precision_delta_at_10: number;
  fact_claim_accuracy: number;
  cases: BenchmarkRecallQualityCase[];
  fact_claim_cases: BenchmarkFactClaimCase[];
}

export interface BenchmarkLatencySuite {
  session_start: Record<SessionStartCanonicalMode, BenchmarkPercentileSummary>;
  recall: Record<
    string,
    BenchmarkPercentileSummary & {
      engine: BenchmarkRecallEngine;
      memory_count: number;
    }
  >;
  deep_recall: BenchmarkPercentileSummary & {
    archive_count: number;
  };
}

export interface BenchmarkEnvironmentSummary {
  recall_engine: BenchmarkRecallEngine;
  ollama_available: boolean;
  token_budget: number;
  db_path: string;
  features: {
    fact_claims: boolean;
    topic_recall: boolean;
    deep_recall: boolean;
    raw_archive: boolean;
  };
}

export interface BenchmarkDatasetSummary {
  session_start_memory_count: number;
  recall_quality_memory_count: number;
  recall_quality_case_count: number;
  recall_latency_scales: number[];
  deep_recall_archive_count: number;
}

export interface BenchmarkFiles {
  json: string;
  markdown: string;
}

export interface BenchmarkTrend {
  previous_run_id: string;
  comparisons: BenchmarkTrendComparison[];
}

export interface BenchmarkReport {
  schema_version: 1;
  run_id: string;
  generated_at: string;
  output_dir: string;
  environment: BenchmarkEnvironmentSummary;
  datasets: BenchmarkDatasetSummary;
  suites: {
    token: BenchmarkTokenSuite;
    recall_quality: BenchmarkRecallQualitySuite;
    latency: BenchmarkLatencySuite;
  };
  checks: BenchmarkThresholdCheck[];
  summary: {
    passed: boolean;
    total_checks: number;
    passed_checks: number;
    failed_checks: number;
  };
  trend?: BenchmarkTrend;
  files: BenchmarkFiles;
}

export type BenchmarkReportWithoutComputed = Omit<
  BenchmarkReport,
  "checks" | "summary" | "trend"
>;
