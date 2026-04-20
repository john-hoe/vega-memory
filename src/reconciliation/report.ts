export const RECONCILIATION_DIMENSIONS = [
  "count",
  "shape",
  "semantic",
  "ordering",
  "derived"
] as const;

export const DEFAULT_RECONCILIATION_DIMENSIONS = [
  "count",
  "shape",
  "semantic",
  "ordering"
] as const;

export const RECONCILIATION_STATUSES = [
  "pass",
  "fail",
  "not_implemented",
  "error"
] as const;

export type ReconciliationDimension = (typeof RECONCILIATION_DIMENSIONS)[number];
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];
export type ReconciliationDirection = "forward" | "reverse";

export interface ReconciliationFindingSummary {
  event_type?: string;
  direction?: ReconciliationDirection;
  expected?: number;
  actual?: number;
  mismatch_count: number;
  sample_ids?: string[];
}

export interface ReconciliationDimensionReport {
  dimension: ReconciliationDimension;
  status: ReconciliationStatus;
  findings: ReconciliationFindingSummary[];
  error?: string;
}

export interface ReconciliationReport {
  schema_version: "1.0";
  run_id: string;
  window_start: number;
  window_end: number;
  dimensions: ReconciliationDimensionReport[];
  totals: {
    pass: number;
    fail: number;
    not_implemented: number;
    error: number;
  };
  generated_at: number;
}

export interface ReconciliationFindingRecord extends ReconciliationFindingSummary {
  status: ReconciliationStatus;
  payload?: Record<string, unknown>;
}

export interface ReconciliationDimensionExecution {
  dimension: ReconciliationDimension;
  status: ReconciliationStatus;
  findings: ReconciliationFindingRecord[];
  error?: string;
}

export function buildReconciliationReport(args: {
  run_id: string;
  window_start: number;
  window_end: number;
  dimensions: ReconciliationDimensionReport[];
  generated_at: number;
}): ReconciliationReport {
  const totals: ReconciliationReport["totals"] = {
    pass: 0,
    fail: 0,
    not_implemented: 0,
    error: 0
  };

  for (const dimension of args.dimensions) {
    totals[dimension.status] += 1;
  }

  return {
    schema_version: "1.0",
    run_id: args.run_id,
    window_start: args.window_start,
    window_end: args.window_end,
    dimensions: args.dimensions,
    totals,
    generated_at: args.generated_at
  };
}
