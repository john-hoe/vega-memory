import { z } from "zod";

import type { DatabaseAdapter } from "../db/adapter.js";
import { evaluateFeatureFlag } from "./evaluator.js";
import type { FlagHitMetricsCollector } from "./metrics.js";
import { inspectFeatureFlagRegistry, type FeatureFlag, type FeatureFlagRegistryDegraded } from "./registry.js";
import { FEATURE_FLAG_SCHEMA_VERSION } from "./runtime.js";

export const EVALUATE_FLAG_INPUT_SCHEMA = z.object({
  flag_id: z.string().min(1),
  context: z
    .object({
      surface: z.string().optional(),
      intent: z.string().optional(),
      session_id: z.string().optional(),
      project: z.string().optional()
    })
    .optional()
});
export const LIST_FLAGS_INPUT_SCHEMA = z.object({});
export const FLAG_METRICS_INPUT_SCHEMA = z.object({});

interface FeatureFlagMcpTool<TName extends string, TResponse> {
  name: TName;
  description: string;
  inputSchema: object;
  invoke(request: unknown): Promise<TResponse>;
}

type EvaluateFlagDegraded =
  | FeatureFlagRegistryDegraded
  | "flag_not_found"
  | "invalid_request"
  | "internal_error";

export interface EvaluateFlagResponse {
  schema_version: typeof FEATURE_FLAG_SCHEMA_VERSION;
  variant: "on" | "off";
  reason: string;
  hit_count: number;
  degraded?: EvaluateFlagDegraded;
}

export interface ListFlagsResponse {
  schema_version: typeof FEATURE_FLAG_SCHEMA_VERSION;
  flags: Array<{
    id: string;
    description: string;
    default: "on" | "off";
    matchers: FeatureFlag["matchers"];
  }>;
  degraded?: FeatureFlagRegistryDegraded;
}

export interface FlagMetricsResponse {
  schema_version: typeof FEATURE_FLAG_SCHEMA_VERSION;
  snapshot: Record<string, {
    on_count: number;
    off_count: number;
    reasons: Record<string, number>;
  }>;
}

const getHitCount = (metrics: FlagHitMetricsCollector | undefined, flagId: string): number => {
  const entry = metrics?.snapshot()[flagId];
  return (entry?.on_count ?? 0) + (entry?.off_count ?? 0);
};

export function evaluateFlagHandler(
  _db: DatabaseAdapter,
  registryPath: string,
  metrics: FlagHitMetricsCollector | undefined,
  request: unknown
): EvaluateFlagResponse {
  try {
    const parsed = EVALUATE_FLAG_INPUT_SCHEMA.safeParse(request ?? {});
    if (!parsed.success) {
      return {
        schema_version: FEATURE_FLAG_SCHEMA_VERSION,
        variant: "off",
        reason: "invalid_request",
        hit_count: 0,
        degraded: "invalid_request"
      };
    }

    const registry = inspectFeatureFlagRegistry(registryPath);
    if (registry.degraded !== undefined) {
      return {
        schema_version: FEATURE_FLAG_SCHEMA_VERSION,
        variant: "off",
        reason: registry.degraded,
        hit_count: getHitCount(metrics, parsed.data.flag_id),
        degraded: registry.degraded
      };
    }

    const flag = registry.flags.find((candidate) => candidate.id === parsed.data.flag_id);
    if (flag === undefined) {
      return {
        schema_version: FEATURE_FLAG_SCHEMA_VERSION,
        variant: "off",
        reason: "flag_not_found",
        hit_count: getHitCount(metrics, parsed.data.flag_id),
        degraded: "flag_not_found"
      };
    }

    const result = evaluateFeatureFlag(flag, parsed.data.context ?? {});
    metrics?.record(parsed.data.flag_id, result.variant, result.reason);

    return {
      schema_version: FEATURE_FLAG_SCHEMA_VERSION,
      variant: result.variant,
      reason: result.reason,
      hit_count: getHitCount(metrics, parsed.data.flag_id)
    };
  } catch {
    return {
      schema_version: FEATURE_FLAG_SCHEMA_VERSION,
      variant: "off",
      reason: "internal_error",
      hit_count: 0,
      degraded: "internal_error"
    };
  }
}

export function listFlagsHandler(
  _db: DatabaseAdapter,
  registryPath: string
): ListFlagsResponse {
  try {
    const registry = inspectFeatureFlagRegistry(registryPath);
    return {
      schema_version: FEATURE_FLAG_SCHEMA_VERSION,
      flags: registry.flags.map((flag) => ({
        id: flag.id,
        description: flag.description,
        default: flag.default,
        matchers: flag.matchers
      })),
      ...(registry.degraded === undefined ? {} : { degraded: registry.degraded })
    };
  } catch {
    return {
      schema_version: FEATURE_FLAG_SCHEMA_VERSION,
      flags: [],
      degraded: "parse_error"
    };
  }
}

export function flagMetricsHandler(
  metrics: FlagHitMetricsCollector | undefined
): FlagMetricsResponse {
  try {
    return {
      schema_version: FEATURE_FLAG_SCHEMA_VERSION,
      snapshot: metrics?.snapshot() ?? {}
    };
  } catch {
    return {
      schema_version: FEATURE_FLAG_SCHEMA_VERSION,
      snapshot: {}
    };
  }
}

export function createEvaluateFlagMcpTool(
  db: DatabaseAdapter,
  registryPath: string,
  metrics: FlagHitMetricsCollector | undefined
): FeatureFlagMcpTool<"feature_flag.evaluate", EvaluateFlagResponse> {
  return {
    name: "feature_flag.evaluate",
    description: "Evaluate a feature flag for the given context.",
    inputSchema: EVALUATE_FLAG_INPUT_SCHEMA.shape,
    async invoke(request: unknown): Promise<EvaluateFlagResponse> {
      return evaluateFlagHandler(db, registryPath, metrics, request);
    }
  };
}

export function createListFlagsMcpTool(
  db: DatabaseAdapter,
  registryPath: string
): FeatureFlagMcpTool<"feature_flag.list", ListFlagsResponse> {
  return {
    name: "feature_flag.list",
    description: "List all registered feature flags and their matchers.",
    inputSchema: LIST_FLAGS_INPUT_SCHEMA.shape,
    async invoke(_request: unknown): Promise<ListFlagsResponse> {
      return listFlagsHandler(db, registryPath);
    }
  };
}

export function createFlagMetricsMcpTool(
  metrics: FlagHitMetricsCollector | undefined
): FeatureFlagMcpTool<"feature_flag.metrics", FlagMetricsResponse> {
  return {
    name: "feature_flag.metrics",
    description: "Return in-memory feature flag evaluation metrics snapshot.",
    inputSchema: FLAG_METRICS_INPUT_SCHEMA.shape,
    async invoke(_request: unknown): Promise<FlagMetricsResponse> {
      return flagMetricsHandler(metrics);
    }
  };
}
