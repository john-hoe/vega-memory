import type { ReconciliationDimension, ReconciliationStatus } from "./report.js";

const DEFAULT_WARN_THRESHOLD = 0.05;
const DEFAULT_CRITICAL_THRESHOLD = 0.1;

export type ReconciliationAlert = {
  severity: "warn" | "critical";
  dimension: string;
  mismatch_rate: number;
  threshold_exceeded: number;
  summary: string;
};

export interface ReconciliationAlertInput {
  dimension: ReconciliationDimension;
  status: ReconciliationStatus;
  mismatch_count: number;
  compared_count: number;
}

export interface ReconciliationAlertConfig {
  warn_threshold?: number;
  critical_threshold?: number;
  per_dimension_overrides?: Partial<
    Record<
      ReconciliationDimension,
      {
        warn?: number;
        critical?: number;
      }
    >
  >;
}

export interface ReconciliationAlertCooldown {
  shouldDispatch(alert: ReconciliationAlert, now: number, cooldownMs: number): boolean;
  record(alert: ReconciliationAlert, now: number): void;
}

const formatPercent = (value: number): string => `${(value * 100).toFixed(1)}%`;

const resolveThresholds = (
  dimension: ReconciliationDimension,
  config: ReconciliationAlertConfig
): { warn: number; critical: number } => {
  const override = config.per_dimension_overrides?.[dimension];
  const warn = override?.warn ?? config.warn_threshold ?? DEFAULT_WARN_THRESHOLD;
  const critical = override?.critical ?? config.critical_threshold ?? DEFAULT_CRITICAL_THRESHOLD;

  return {
    warn,
    critical
  };
};

export function evaluateReconciliationAlerts(
  findings: ReconciliationAlertInput[],
  config: ReconciliationAlertConfig = {}
): ReconciliationAlert[] {
  const alerts: ReconciliationAlert[] = [];

  for (const finding of findings) {
    if (finding.status !== "fail" || finding.compared_count <= 0) {
      continue;
    }

    const mismatchRate = finding.mismatch_count / finding.compared_count;
    const thresholds = resolveThresholds(finding.dimension, config);
    const severity =
      mismatchRate >= thresholds.critical
        ? "critical"
        : mismatchRate >= thresholds.warn
          ? "warn"
          : null;

    if (severity === null) {
      continue;
    }

    const thresholdExceeded =
      severity === "critical" ? thresholds.critical : thresholds.warn;

    alerts.push({
      severity,
      dimension: finding.dimension,
      mismatch_rate: mismatchRate,
      threshold_exceeded: thresholdExceeded,
      summary: [
        `Dimension ${finding.dimension} exceeded the ${formatPercent(thresholdExceeded)} threshold.`,
        `Mismatch rate: ${formatPercent(mismatchRate)} (${finding.mismatch_count}/${finding.compared_count}).`
      ].join(" ")
    });
  }

  return alerts;
}

export function createReconciliationAlertCooldown(): ReconciliationAlertCooldown {
  const lastAlertAt = new Map<string, number>();

  return {
    shouldDispatch(alert, now, cooldownMs): boolean {
      const key = `${alert.dimension}:${alert.severity}`;
      const previous = lastAlertAt.get(key);

      return previous === undefined || now - previous >= cooldownMs;
    },
    record(alert, now): void {
      lastAlertAt.set(`${alert.dimension}:${alert.severity}`, now);
    }
  };
}
