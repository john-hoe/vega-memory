import type { SourceKind } from "../core/contracts/enums.js";
import type { SourceRecord } from "./sources/types.js";

import type { RankerConfig, RankedRecord } from "./ranker.js";

export function clampScore(score: number): number {
  if (score < 0) {
    return 0;
  }

  if (score > 1) {
    return 1;
  }

  return score;
}

export function getBaseScore(record: SourceRecord): number {
  return clampScore(record.raw_score ?? 0.5);
}

export function getSourcePrior(
  sourceKind: SourceKind,
  priors: RankerConfig["source_priors"]
): number {
  return clampScore(priors[sourceKind] ?? 0.5);
}

export function scoreRecord(record: SourceRecord, config: RankerConfig): RankedRecord {
  const base = getBaseScore(record);
  const source_prior = getSourcePrior(record.source_kind, config.source_priors);
  const recency = 1;
  const safety_penalty = 0;
  const blended = clampScore(0.4 * base + 0.4 * source_prior + 0.2 * recency - safety_penalty);
  const final_score =
    record.source_kind === "host_memory_file"
      ? Math.max(blended, clampScore(config.host_memory_file_floor))
      : blended;

  return {
    ...record,
    final_score,
    score_breakdown: {
      base,
      source_prior,
      recency,
      safety_penalty
    }
  };
}
