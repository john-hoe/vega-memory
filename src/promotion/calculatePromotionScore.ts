export interface PromotionScoreInput {
  frequency: number;
  crossSession: boolean;
  explicit: boolean;
  quality: number;
}

export interface PromotionScoreResult {
  score: number;
  promotable: boolean;
}

const DEFAULT_PROMOTION_THRESHOLD = 0.7;

/**
 * Calculate a promotion score (0–1) from signal inputs.
 *
 * - quality:   0–1, weight 0.35
 * - frequency: 0–1, weight 0.30
 * - crossSession: boolean, bonus 0.20
 * - explicit:     boolean, bonus 0.15
 *
 * Score is clamped to [0, 1].
 * promotable is true when score >= DEFAULT_PROMOTION_THRESHOLD (0.7).
 */
export function calculatePromotionScore(input: PromotionScoreInput): number {
  const base = input.quality * 0.35 + input.frequency * 0.30;
  const bonus = (input.crossSession ? 0.20 : 0) + (input.explicit ? 0.15 : 0);
  const score = Math.min(1, Math.max(0, base + bonus));
  return score;
}

/**
 * Calculate promotion score with the full result object.
 */
export function calculatePromotionScoreWithResult(
  input: PromotionScoreInput,
  threshold = DEFAULT_PROMOTION_THRESHOLD
): PromotionScoreResult {
  const score = calculatePromotionScore(input);
  return { score, promotable: score >= threshold };
}
