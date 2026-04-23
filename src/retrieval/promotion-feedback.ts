import type { CandidateRepository } from "../db/candidate-repository.js";
import type { CheckpointRecord } from "../core/contracts/checkpoint-record.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import type { SourceKind } from "../core/contracts/enums.js";
import type { PromotionAuditStore } from "../promotion/audit-store.js";

import type { RankerConfig } from "./ranker.js";
import type { SourcePlan } from "./source-plan.js";

const MAX_SOURCE_PRIOR_DELTA = 0.15;

export interface PromotionFeedbackSummary {
  preferred_sources: SourceKind[];
  suppressed_sources: SourceKind[];
  source_prior_delta: Partial<Record<SourceKind, number>>;
  disabled: boolean;
}

function uniqueSources(sources: SourceKind[]): SourceKind[] {
  return [...new Set(sources)];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampDelta(value: number): number {
  return Math.max(-MAX_SOURCE_PRIOR_DELTA, Math.min(MAX_SOURCE_PRIOR_DELTA, value));
}

function hasActiveVisibleCandidates(repository?: CandidateRepository): boolean {
  if (repository === undefined) {
    return false;
  }

  return repository
    .list({
      limit: 50,
      project: undefined,
      visibility_gated: false
    })
    .some((candidate) => candidate.candidate_state !== "discarded");
}

export function collectPromotionFeedback(input: {
  request: IntentRequest;
  candidateRepository?: CandidateRepository;
  promotionAuditStore?: PromotionAuditStore;
  previousCheckpoint?: CheckpointRecord;
}): PromotionFeedbackSummary {
  if (
    input.request.intent === "followup" &&
    (input.previousCheckpoint?.followup_depth ?? 0) >= 1
  ) {
    return {
      preferred_sources: [],
      suppressed_sources: [],
      source_prior_delta: {},
      disabled: true
    };
  }

  const audits = input.promotionAuditStore?.listRecent(50) ?? [];
  const promoteCount = audits.filter((entry) => entry.action === "promote").length;
  const holdCount = audits.filter((entry) => entry.action === "hold").length;
  const demoteCount = audits.filter((entry) => entry.action === "demote").length;
  const discardCount = audits.filter((entry) => entry.action === "discard").length;
  const hasActiveCandidates = hasActiveVisibleCandidates(input.candidateRepository);

  const preferred_sources: SourceKind[] = [];
  const suppressed_sources: SourceKind[] = [];
  const source_prior_delta: Partial<Record<SourceKind, number>> = {};

  if (promoteCount > 0) {
    preferred_sources.push("vega_memory");
    source_prior_delta.vega_memory = clampDelta(promoteCount * 0.05);
  }

  if (input.request.intent === "followup" && holdCount + demoteCount > 0) {
    preferred_sources.push("candidate");
    source_prior_delta.candidate = clampDelta((holdCount + demoteCount) * 0.05);
  }

  if (!hasActiveCandidates && discardCount > 0) {
    suppressed_sources.push("candidate");
    source_prior_delta.candidate = clampDelta((source_prior_delta.candidate ?? 0) - discardCount * 0.05);
  }

  return {
    preferred_sources: uniqueSources(preferred_sources),
    suppressed_sources: uniqueSources(suppressed_sources),
    source_prior_delta,
    disabled: false
  };
}

export function applyPromotionFeedbackToSourcePlan(
  plan: SourcePlan,
  feedback: PromotionFeedbackSummary
): SourcePlan {
  if (feedback.disabled) {
    return plan;
  }

  const stripSuppressed = (sources: SourceKind[]): SourceKind[] =>
    sources.filter((source) => !feedback.suppressed_sources.includes(source));

  const prependPreferred = (sources: SourceKind[]): SourceKind[] =>
    uniqueSources([
      ...feedback.preferred_sources.filter((source) => !feedback.suppressed_sources.includes(source)),
      ...sources
    ]);

  return {
    ...plan,
    preferred_sources: uniqueSources([...plan.preferred_sources, ...feedback.preferred_sources]),
    primary_sources: prependPreferred(stripSuppressed(plan.primary_sources)),
    fallback_sources: prependPreferred(stripSuppressed(plan.fallback_sources)).filter(
      (source) => !plan.primary_sources.includes(source)
    )
  };
}

export function applyPromotionFeedbackToRankerConfig(
  base: RankerConfig,
  feedback: PromotionFeedbackSummary
): RankerConfig {
  if (feedback.disabled) {
    return base;
  }

  const source_priors = { ...base.source_priors };

  for (const [source, delta] of Object.entries(feedback.source_prior_delta) as Array<
    [SourceKind, number | undefined]
  >) {
    if (delta === undefined) {
      continue;
    }

    source_priors[source] = clampScore((source_priors[source] ?? 0.5) + delta);
  }

  return {
    ...base,
    source_priors
  };
}
