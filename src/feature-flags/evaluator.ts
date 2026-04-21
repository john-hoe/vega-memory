import { hashBucket } from "./bucketing.js";
import type { FeatureFlag } from "./registry.js";

export interface EvaluationContext {
  surface?: string;
  intent?: string;
  session_id?: string;
  project?: string;
}

export interface EvaluationResult {
  variant: "on" | "off";
  reason: string;
}

/**
 * Evaluate a single feature flag against the provided context.
 * Pure function: no DB / env / disk / network reads.
 */
export function evaluateFeatureFlag(
  flag: FeatureFlag,
  ctx: EvaluationContext
): EvaluationResult {
  // 1. Match surfaces
  const surfaceMatch =
    flag.matchers.surfaces === "*" ||
    (ctx.surface !== undefined && flag.matchers.surfaces.includes(ctx.surface));

  // 2. Match intents
  const intentMatch =
    flag.matchers.intents === "*" ||
    (ctx.intent !== undefined && flag.matchers.intents.includes(ctx.intent));

  // 3. If neither matches, return default
  if (!surfaceMatch || !intentMatch) {
    return { variant: flag.default, reason: "matcher_miss" };
  }

  // 4. Traffic percent shortcuts
  if (flag.matchers.traffic_percent === 0) {
    return { variant: "off", reason: "traffic_0" };
  }
  if (flag.matchers.traffic_percent === 100) {
    return { variant: "on", reason: "traffic_100" };
  }

  // 5. Bucketed rollout
  const seedField = flag.bucketing?.seed_field ?? "session_id";
  const seed = ctx[seedField] ?? "default";
  const bucket = hashBucket(seed, flag.id);
  const threshold = flag.matchers.traffic_percent;
  const variant = bucket < threshold ? "on" : "off";
  const reason = `bucket_${bucket}_${threshold}`;

  return { variant, reason };
}
