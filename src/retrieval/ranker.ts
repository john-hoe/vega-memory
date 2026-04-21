import type { IntentRequest } from "../core/contracts/intent.js";
import type { SourceKind } from "../core/contracts/enums.js";
import { createLogger } from "../core/logging/index.js";
import {
  DEFAULT_FEATURE_FLAG_REGISTRY_PATH,
  evaluateFeatureFlag,
  loadFeatureFlagRegistry
} from "../feature-flags/index.js";

import type { SourceRecord } from "./sources/types.js";
import { scoreRecord } from "./ranker-score.js";

export interface RankedRecord extends SourceRecord {
  final_score: number;
  score_breakdown: {
    base: number;
    source_prior: number;
    recency: number;
  };
}

export interface RankerConfig {
  source_priors: Partial<Record<SourceKind, number>>;
  score_version: string;
}

export const DEFAULT_RANKER_CONFIG: RankerConfig = {
  source_priors: {
    vega_memory: 0.7,
    wiki: 0.5,
    fact_claim: 0.6,
    graph: 0.4,
    archive: 0.3,
    candidate: 0.4,
    host_memory_file: 0.3
  },
  score_version: "v1.1"
};

const logger = createLogger({
  name: "retrieval-ranker",
  minLevel: "error"
});
const RANKER_RECENCY_HALFLIFE_14D_FLAG_ID = "ranker-recency-halflife-14d";
const DEFAULT_RANKER_HALF_LIFE_DAYS = 7;
const EXPERIMENT_RANKER_HALF_LIFE_DAYS = 14;

let cachedFeatureFlagRegistryPath: string | undefined;
let cachedFeatureFlags: ReturnType<typeof loadFeatureFlagRegistry> | undefined;

function resolveFeatureFlagRegistryPath(): string {
  const override = process.env.VEGA_FEATURE_FLAG_REGISTRY_PATH?.trim();
  return override && override.length > 0 ? override : DEFAULT_FEATURE_FLAG_REGISTRY_PATH;
}

function getFeatureFlags(): ReturnType<typeof loadFeatureFlagRegistry> {
  const registryPath = resolveFeatureFlagRegistryPath();

  if (cachedFeatureFlagRegistryPath !== registryPath || cachedFeatureFlags === undefined) {
    cachedFeatureFlagRegistryPath = registryPath;
    cachedFeatureFlags = loadFeatureFlagRegistry(registryPath);
  }

  return cachedFeatureFlags;
}

function resolveRankerHalfLifeDays(request: IntentRequest): number {
  const flag = getFeatureFlags().find(
    (candidate) => candidate.id === RANKER_RECENCY_HALFLIFE_14D_FLAG_ID
  );
  const variant =
    flag === undefined
      ? "off"
      : evaluateFeatureFlag(flag, {
          surface: request.surface,
          intent: request.intent,
          session_id: request.session_id,
          project: request.project ?? undefined
        }).variant;

  return variant === "on"
    ? EXPERIMENT_RANKER_HALF_LIFE_DAYS
    : DEFAULT_RANKER_HALF_LIFE_DAYS;
}

function mergeConfig(config?: RankerConfig): RankerConfig {
  return {
    source_priors: {
      ...DEFAULT_RANKER_CONFIG.source_priors,
      ...(config?.source_priors ?? {})
    },
    // TODO(Wave 5, issue #32): re-introduce host_memory_file-specific ranker config
    // when the adapter returns real records instead of remaining a disabled stub.
    score_version: config?.score_version ?? DEFAULT_RANKER_CONFIG.score_version
  };
}

export function rank(
  records: SourceRecord[],
  request: IntentRequest,
  config?: RankerConfig,
  demote_ids?: ReadonlySet<string>,
  halfLifeDays?: number
): RankedRecord[] {
  const mergedConfig = mergeConfig(config);
  const effectiveHalfLifeDays = halfLifeDays ?? resolveRankerHalfLifeDays(request);
  const ranked = records
    .map((record) => scoreRecord(record, mergedConfig, demote_ids, effectiveHalfLifeDays))
    .sort((left, right) => right.final_score - left.final_score);

  logger.debug("Ranked retrieval records", {
    intent: request.intent,
    mode: request.mode,
    score_version: mergedConfig.score_version,
    record_count: records.length
  });

  return ranked;
}
