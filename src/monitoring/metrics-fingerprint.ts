// HELP fragments must describe WHAT the metric counts (semantic),
// not HOW the code detects it (implementation details / symbols).
//
// GOOD:   stable semantic phrases
// BAD:    code-level comparisons, method calls, or symbolic arrows
//
// Rule: a harmless HELP rephrase MUST NOT trip the drift test unless
// the metric's semantic contract changed.

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricFingerprint {
  readonly name: string;
  readonly type: MetricType;
  readonly labelKeys: readonly string[];
  readonly helpFragment: string;
}

export const METRICS_FINGERPRINT = [
  {
    name: "vega_retrieval_calls_total",
    type: "counter",
    labelKeys: ["surface", "intent"],
    helpFragment: "resolve attempt"
  },
  {
    name: "vega_retrieval_nonempty_total",
    type: "counter",
    labelKeys: ["surface", "intent"],
    helpFragment: "non-empty retrieval bundle"
  },
  {
    name: "vega_retrieval_token_efficiency_ratio",
    type: "gauge",
    labelKeys: ["surface", "intent"],
    helpFragment: "retrieval token efficiency proxy"
  },
  {
    name: "vega_retrieval_source_utilization_ratio",
    type: "gauge",
    labelKeys: ["surface", "intent"],
    helpFragment: "source utilization ratio"
  },
  {
    name: "vega_retrieval_bundle_coverage_ratio",
    type: "gauge",
    labelKeys: ["surface", "intent"],
    helpFragment: "bundle coverage proxy"
  },
  {
    name: "vega_usage_ack_total",
    type: "counter",
    labelKeys: ["surface", "sufficiency", "host_tier"],
    helpFragment: "first-time usage ack"
  },
  {
    name: "vega_usage_checkpoint_submitted_total",
    type: "counter",
    labelKeys: ["decision_state"],
    helpFragment: "bundle consumption checkpoints"
  },
  {
    name: "vega_usage_checkpoint_rejected_total",
    type: "counter",
    labelKeys: ["reason"],
    helpFragment: "rejected Phase 7 bundle consumption checkpoints"
  },
  {
    name: "vega_usage_checkpoint_low_confidence_total",
    type: "counter",
    labelKeys: ["decision_state"],
    helpFragment: "low-confidence handling"
  },
  {
    name: "vega_usage_fallback_target_total",
    type: "counter",
    labelKeys: ["target"],
    helpFragment: "fallback ladder plans"
  },
  {
    name: "vega_usage_fallback_violation_total",
    type: "counter",
    labelKeys: ["reason"],
    helpFragment: "fallback ladder guard violations"
  },
  {
    name: "vega_usage_feedback_ack_total",
    type: "counter",
    labelKeys: ["ack_type"],
    helpFragment: "memory feedback acknowledgements"
  },
  {
    name: "vega_usage_feedback_ack_rejected_total",
    type: "counter",
    labelKeys: ["reason"],
    helpFragment: "rejected or degraded Phase 7 memory feedback acknowledgements"
  },
  {
    name: "vega_usage_followup_loop_override_total",
    type: "counter",
    labelKeys: ["surface"],
    helpFragment: "loop guard override"
  },
  {
    name: "vega_retrieval_missing_trigger_total",
    type: "counter",
    labelKeys: ["surface"],
    helpFragment: "missing retrieval trigger"
  },
  {
    name: "vega_retrieval_skipped_bundle_total",
    type: "counter",
    labelKeys: ["surface"],
    helpFragment: "host did not consume the expected retrieval bundle"
  },
  {
    name: "vega_retrieval_followup_inflation_total",
    type: "counter",
    labelKeys: ["surface"],
    helpFragment: "repeated followup inflation"
  },
  {
    name: "vega_circuit_breaker_state",
    type: "gauge",
    labelKeys: ["surface"],
    helpFragment: "current per-surface circuit breaker state"
  },
  {
    name: "vega_circuit_breaker_trips_total",
    type: "counter",
    labelKeys: ["surface", "reason"],
    helpFragment: "circuit breaker trips"
  },
  {
    name: "vega_raw_inbox_rows",
    type: "gauge",
    labelKeys: ["event_type"],
    helpFragment: "grouped raw inbox backlog"
  },
  {
    name: "vega_raw_inbox_oldest_age_seconds",
    type: "gauge",
    labelKeys: ["event_type"],
    helpFragment: "backlog age signal"
  }
] as const satisfies readonly MetricFingerprint[];
