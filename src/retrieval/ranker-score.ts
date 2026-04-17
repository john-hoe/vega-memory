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
  // TODO(Wave 5, issue #31): re-introduce recency / access_frequency / safety_penalty signals
  // when the Memory model exposes updated_at, access_count, and redaction tags;
  // narrowed score_breakdown and formula to only use base + source_prior for now.
  // TODO(Wave 5, issue #32): restore host_memory_file-specific floor logic only after the
  // adapter can surface real records instead of staying disabled by default.
  const final_score = clampScore(0.5 * base + 0.5 * source_prior);

  return {
    ...record,
    final_score,
    score_breakdown: {
      base,
      source_prior
    }
  };
}
