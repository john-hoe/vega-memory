import type { AlertRule } from "./rules.js";

export type AlertState = "firing" | "pending" | "resolved" | "skipped";

export interface AlertEvaluation {
  rule_id: string;
  state: AlertState;
  value: number | null;
  reasons: string[];
  evaluated_at: string;
}

export interface EvaluateAlertRulesOptions {
  metricsQuery: (metric: string, windowMs: number) => Promise<number | null>;
  now?: () => Date;
}

const compareThreshold = (value: number, operator: AlertRule["operator"], threshold: number): boolean => {
  switch (operator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
  }
};

export async function evaluateAlertRules(
  rules: AlertRule[],
  options: EvaluateAlertRulesOptions
): Promise<AlertEvaluation[]> {
  const now = options.now ?? (() => new Date());
  const evaluatedAt = now().toISOString();
  const evaluations: AlertEvaluation[] = [];

  for (const rule of rules) {
    const value = await options.metricsQuery(rule.metric, rule.window_ms);

    if (value === null) {
      evaluations.push({
        rule_id: rule.id,
        state: "skipped",
        value: null,
        reasons: ["metric_unavailable"],
        evaluated_at: evaluatedAt
      });
      continue;
    }

    if (!compareThreshold(value, rule.operator, rule.threshold)) {
      evaluations.push({
        rule_id: rule.id,
        state: "resolved",
        value,
        reasons: ["threshold_not_crossed"],
        evaluated_at: evaluatedAt
      });
      continue;
    }

    if (rule.min_duration_ms > rule.window_ms) {
      evaluations.push({
        rule_id: rule.id,
        state: "pending",
        value,
        reasons: ["threshold_crossed", "min_duration_not_met"],
        evaluated_at: evaluatedAt
      });
      continue;
    }

    evaluations.push({
      rule_id: rule.id,
      state: "firing",
      value,
      reasons: ["threshold_crossed"],
      evaluated_at: evaluatedAt
    });
  }

  return evaluations;
}
