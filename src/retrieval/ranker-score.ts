import { recordKey } from "../core/contracts/checkpoint-record.js";
import type { SourceKind } from "../core/contracts/enums.js";
import type { SourceRecord } from "./sources/types.js";

import type { RankerConfig, RankedRecord } from "./ranker.js";

const DEMOTION_FACTOR = 0.3;
export const HOST_MEMORY_FILE_FLOOR = 0.05;
const RECENCY_HALF_LIFE_DAYS = 7;

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

function toTimestamp(created_at: SourceRecord["created_at"], now: number): number {
  if (created_at instanceof Date) {
    return created_at.getTime();
  }

  if (typeof created_at === "number") {
    return Number.isFinite(created_at) ? created_at : now;
  }

  if (typeof created_at === "string") {
    const parsed = Date.parse(created_at);
    return Number.isFinite(parsed) ? parsed : now;
  }

  return now;
}

export function computeRecency(
  created_at: SourceRecord["created_at"],
  now: number = Date.now(),
  halfLifeDays = RECENCY_HALF_LIFE_DAYS
): number {
  if (halfLifeDays <= 0) {
    return 1;
  }

  const createdAtMs = toTimestamp(created_at, now);
  const ageMs = now - createdAtMs;

  if (ageMs <= 0) {
    return 1;
  }

  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const decayed = Math.exp((-Math.LN2 * ageDays) / halfLifeDays);

  return clampScore(decayed);
}

export function scoreRecord(
  record: SourceRecord,
  config: RankerConfig,
  demote_ids?: ReadonlySet<string>,
  halfLifeDays = RECENCY_HALF_LIFE_DAYS
): RankedRecord {
  const base = getBaseScore(record);
  const source_prior = getSourcePrior(record.source_kind, config.source_priors);
  const recency = computeRecency(record.created_at, Date.now(), halfLifeDays);
  // TODO(Wave 5, issue #32): restore host_memory_file-specific floor logic only after the
  // adapter can surface real records instead of staying disabled by default.
  let final_score = (base + source_prior + recency) / 3;

  if (demote_ids?.has(recordKey(record.source_kind, record.id))) {
    final_score *= DEMOTION_FACTOR;
  }

  if (record.source_kind === "host_memory_file") {
    final_score = Math.max(final_score, HOST_MEMORY_FILE_FLOOR);
  }

  final_score = clampScore(final_score);

  return {
    ...record,
    final_score,
    score_breakdown: {
      base,
      source_prior,
      recency
    }
  };
}
