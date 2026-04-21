import type { IntentRequest } from "../core/contracts/intent.js";
import type { SourceKind } from "../core/contracts/enums.js";
import { createLogger } from "../core/logging/index.js";

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
  score_version: "v1.0"
};

const logger = createLogger({
  name: "retrieval-ranker",
  minLevel: "error"
});

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
  demote_ids?: ReadonlySet<string>
): RankedRecord[] {
  const mergedConfig = mergeConfig(config);
  const ranked = records
    .map((record) => scoreRecord(record, mergedConfig, demote_ids))
    .sort((left, right) => right.final_score - left.final_score);

  logger.debug("Ranked retrieval records", {
    intent: request.intent,
    mode: request.mode,
    score_version: mergedConfig.score_version,
    record_count: records.length
  });

  return ranked;
}
