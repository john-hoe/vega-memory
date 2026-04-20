import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";

import type { SunsetCandidate } from "./registry.js";

const DAY_IN_MS = 86_400_000;
const logger = createLogger({ name: "sunset-evaluator" });

export type { SunsetCandidate } from "./registry.js";

export type SunsetStatus = "ready" | "pending" | "skipped";

export interface SunsetEvaluationResult {
  candidate_id: string;
  status: SunsetStatus;
  reasons: string[];
  evaluated_at: string;
}

export interface SunsetEvaluatorOptions {
  db?: DatabaseAdapter;
  now?: Date;
  metricsQuery?: (metric: string, windowDays: number) => Promise<number | null>;
}

const toUtcMidnight = (value: Date): number =>
  Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());

const parseDeprecatedSince = (value: string): number => {
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  return Date.UTC(year, month - 1, day);
};

const getElapsedDays = (deprecatedSince: string, now: Date): number =>
  Math.floor((toUtcMidnight(now) - parseDeprecatedSince(deprecatedSince)) / DAY_IN_MS);

export async function evaluateSunsetCandidates(
  candidates: SunsetCandidate[],
  options: SunsetEvaluatorOptions = {}
): Promise<SunsetEvaluationResult[]> {
  void options.db;

  const now = options.now ?? new Date();
  const evaluatedAt = now.toISOString();
  const metricsQuery = options.metricsQuery ?? (async () => null);

  return Promise.all(
    candidates.map(async (candidate) => {
      const reasons: string[] = [];
      let isReady = false;

      if (candidate.criteria.time_based !== undefined) {
        const elapsedDays = getElapsedDays(candidate.deprecated_since, now);
        const minimumDays = candidate.criteria.time_based.min_days_since_deprecated;

        if (elapsedDays >= minimumDays) {
          reasons.push(`time_based: ${elapsedDays} days elapsed >= ${minimumDays}`);
          isReady = true;
        } else {
          reasons.push(`time_based: ${elapsedDays} days elapsed < ${minimumDays}`);
        }
      }

      if (candidate.criteria.usage_threshold !== undefined) {
        try {
          const usage = await metricsQuery(
            candidate.criteria.usage_threshold.metric,
            candidate.criteria.usage_threshold.window_days
          );

          if (usage === null) {
            reasons.push("metric_unavailable");
          } else if (usage <= candidate.criteria.usage_threshold.max_calls) {
            reasons.push(
              `usage_threshold: ${usage} calls <= ${candidate.criteria.usage_threshold.max_calls} over ${candidate.criteria.usage_threshold.window_days} days`
            );
            isReady = true;
          } else {
            reasons.push(
              `usage_threshold: ${usage} calls > ${candidate.criteria.usage_threshold.max_calls} over ${candidate.criteria.usage_threshold.window_days} days`
            );
          }
        } catch (error) {
          logger.warn("Sunset metrics query failed.", {
            candidate_id: candidate.id,
            metric: candidate.criteria.usage_threshold.metric,
            error: error instanceof Error ? error.message : String(error)
          });
          reasons.push("metric_unavailable");
        }
      }

      return {
        candidate_id: candidate.id,
        status: isReady ? "ready" : "pending",
        reasons,
        evaluated_at: evaluatedAt
      } satisfies SunsetEvaluationResult;
    })
  );
}
