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
    helpFragment: "records.length > 0"
  },
  {
    name: "vega_usage_ack_total",
    type: "counter",
    labelKeys: ["surface", "sufficiency", "host_tier"],
    helpFragment: "putResult.status === inserted"
  },
  {
    name: "vega_usage_followup_loop_override_total",
    type: "counter",
    labelKeys: ["surface"],
    helpFragment: "loop guard override"
  },
  {
    name: "vega_circuit_breaker_state",
    type: "gauge",
    labelKeys: ["surface"],
    helpFragment: "state transitions"
  },
  {
    name: "vega_circuit_breaker_trips_total",
    type: "counter",
    labelKeys: ["surface", "reason"],
    helpFragment: "closed -> open transitions"
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
