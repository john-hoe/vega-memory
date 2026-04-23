import { createHash } from "node:crypto";

import { v4 as uuidv4 } from "uuid";

import type { Bundle } from "../core/contracts/bundle.js";
import { BUNDLE_SCHEMA } from "../core/contracts/bundle.js";
import type { CheckpointRecord } from "../core/contracts/checkpoint-record.js";
import { recordKey } from "../core/contracts/checkpoint-record.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import type { Mode, SourceKind } from "../core/contracts/enums.js";
import { createLogger, createTraceId } from "../core/logging/index.js";
import type { CandidateRepository } from "../db/candidate-repository.js";
import {
  DEFAULT_FEATURE_FLAG_REGISTRY_PATH,
  evaluateFeatureFlag,
  loadFeatureFlagRegistry,
  type EvaluationContext,
  type FeatureFlag
} from "../feature-flags/index.js";
import type { CheckpointFailureStore } from "../usage/checkpoint-failure-store.js";
import type { CheckpointStore } from "../usage/checkpoint-store.js";
import type { VegaMetricsRegistry } from "../monitoring/vega-metrics.js";

import { applyBudget, estimateTokens, type BudgetConfig, DEFAULT_BUDGET_CONFIG } from "./budget.js";
import { assembleBundle } from "./bundler.js";
import type {
  CircuitBreaker,
  CircuitBreakerTripReason
} from "./circuit-breaker.js";
import { getProfile } from "./profiles.js";
import type { PromotionAuditStore } from "../promotion/audit-store.js";
import {
  applyPromotionFeedbackToRankerConfig,
  applyPromotionFeedbackToSourcePlan,
  collectPromotionFeedback
} from "./promotion-feedback.js";
import { rank, type RankerConfig, DEFAULT_RANKER_CONFIG } from "./ranker.js";
import { createResolveCache, type ResolveCache } from "./resolve-cache.js";
import { createSourcePlan } from "./source-plan.js";
import { classifySufficiency } from "./sufficiency-classifier.js";
import type { SourceRegistry } from "./sources/registry.js";
import type { SourceSearchInput } from "./sources/types.js";

export interface CircuitBreakerSignal {
  open: true;
  tripped_at: number;
  reasons: CircuitBreakerTripReason[];
}

export interface ContextResolveResponse {
  checkpoint_id: string;
  bundle_digest: string;
  bundle: Bundle;
  sufficiency_hint?: "likely_sufficient" | "may_need_followup";
  profile_used: string;
  ranker_version: string;
  circuit_breaker?: CircuitBreakerSignal;
  used_sources: string[];
  fallback_used: boolean;
  confidence: number;
  warnings: string[];
  next_retrieval_hint: string;
}

export interface OrchestratorConfig {
  registry: SourceRegistry;
  ranker_config?: RankerConfig;
  budget_config?: BudgetConfig;
  followup_guardrails?: {
    cooldown_ms?: number;
    max_followups?: number;
  };
  candidate_repository?: CandidateRepository;
  promotion_audit_store?: PromotionAuditStore;
  resolve_cache?: ResolveCache;
  checkpoint_store?: CheckpointStore;
  checkpoint_failure_store?: CheckpointFailureStore;
  circuit_breaker?: CircuitBreaker;
  metrics?: VegaMetricsRegistry;
  now?: () => number;
}

const logger = createLogger({ name: "retrieval-orchestrator" });
const DEFAULT_FOLLOWUP_COOLDOWN_MS = 0;
const DEFAULT_MAX_FOLLOWUPS = 2;
const ERROR_BUNDLE = BUNDLE_SCHEMA.parse({
  schema_version: "1.0",
  checkpoint_id: "error",
  bundle_digest: "error",
  sections: [],
  used_sources: [],
  fallback_used: false,
  confidence: 0,
  warnings: ["resolve_failed"],
  next_retrieval_hint: "none"
});
const RETRIEVAL_QUERYLESS_BOOTSTRAP_FLAG_ID = "retrieval-queryless-bootstrap";

function resolveFeatureFlagRegistryPath(): string {
  const override = process.env.VEGA_FEATURE_FLAG_REGISTRY_PATH?.trim();
  return override && override.length > 0 ? override : DEFAULT_FEATURE_FLAG_REGISTRY_PATH;
}

function resolveFlagVariant(
  flags: FeatureFlag[],
  id: string,
  fallback: "on" | "off",
  context: EvaluationContext
): "on" | "off" {
  const flag = flags.find((candidate) => candidate.id === id);
  return flag === undefined ? fallback : evaluateFeatureFlag(flag, context).variant;
}

function isQuerylessRequest(request: IntentRequest): boolean {
  return (request.query ?? "").trim().length === 0;
}

function resolveMode(request: IntentRequest): Mode {
  return request.mode ?? "L1";
}

function createQueryHash(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

function isNonemptyBundle(response: ContextResolveResponse): boolean {
  return (
    response.bundle_digest !== "error" &&
    response.bundle.sections.some((section) => section.records.length > 0)
  );
}

function resolveRankerVersion(config?: RankerConfig): string {
  return config?.score_version ?? DEFAULT_RANKER_CONFIG.score_version;
}

function resolveBudgetConfig(
  mode: Mode,
  config: BudgetConfig | undefined,
  overrideTokens: number | undefined
): BudgetConfig | undefined {
  if (overrideTokens === undefined) {
    return config;
  }

  return {
    max_tokens_by_mode: {
      ...DEFAULT_BUDGET_CONFIG.max_tokens_by_mode,
      ...(config?.max_tokens_by_mode ?? {}),
      [mode]: overrideTokens
    },
    host_memory_file_reserved:
      config?.host_memory_file_reserved ?? DEFAULT_BUDGET_CONFIG.host_memory_file_reserved
  };
}

function applyBudgetReduction(
  config: BudgetConfig | undefined,
  factor: number
): BudgetConfig {
  const base = {
    max_tokens_by_mode: {
      ...DEFAULT_BUDGET_CONFIG.max_tokens_by_mode,
      ...(config?.max_tokens_by_mode ?? {})
    },
    host_memory_file_reserved:
      config?.host_memory_file_reserved ?? DEFAULT_BUDGET_CONFIG.host_memory_file_reserved
  };

  return {
    ...base,
    max_tokens_by_mode: {
      L0: Math.round(base.max_tokens_by_mode.L0 * factor),
      L1: Math.round(base.max_tokens_by_mode.L1 * factor),
      L2: Math.round(base.max_tokens_by_mode.L2 * factor),
      L3: Math.round(base.max_tokens_by_mode.L3 * factor)
    }
  };
}

function buildWarnings(input: {
  fallbackUsed: boolean;
  exhaustedFallback: boolean;
  truncatedCount: number;
  focus: string | null;
}): string[] {
  const warnings: string[] = [];

  if (input.fallbackUsed) {
    warnings.push("retrieval_fallback_used");
  }

  if (input.exhaustedFallback) {
    warnings.push("retrieval_fallback_exhausted");
  }

  if (input.truncatedCount > 0) {
    warnings.push("retrieval_bundle_truncated");
  }

  if (input.focus !== null) {
    warnings.push(`query_focus:${input.focus}`);
  }

  return warnings;
}

function resolveNextRetrievalHint(input: {
  intent: IntentRequest["intent"];
  hint: "likely_sufficient" | "may_need_followup";
  budgetedCount: number;
  exhaustedFallback: boolean;
}): string {
  if (input.budgetedCount === 0) {
    if (input.intent === "evidence" || input.exhaustedFallback) {
      return "needs_external";
    }

    return "broaden_query";
  }

  if (input.hint === "may_need_followup") {
    return "followup";
  }

  return "none";
}

function resolveConfidence(input: {
  topK: number;
  budgetedCount: number;
  truncatedCount: number;
  fallbackUsed: boolean;
}): number {
  const base = Math.min(1, input.budgetedCount / Math.max(1, input.topK));
  const penalty =
    (input.truncatedCount > 0 ? 0.2 : 0) +
    (input.fallbackUsed ? 0.1 : 0);

  return Math.max(0, Math.min(1, Number((base - penalty).toFixed(2))));
}

function resolveSourceUtilization(input: {
  usedSourceCount: number;
  queriedSourceCount: number;
}): number {
  if (input.queriedSourceCount <= 0) {
    return 0;
  }

  return Number((input.usedSourceCount / input.queriedSourceCount).toFixed(2));
}

function resolveTokenEfficiency(input: {
  bundleTokens: number;
  rawRetrievedTokens: number;
}): number {
  if (input.rawRetrievedTokens <= 0) {
    return 0;
  }

  return Number(Math.min(1, input.bundleTokens / input.rawRetrievedTokens).toFixed(2));
}

function resolveBundleCoverage(input: {
  budgetedCount: number;
  expectedTopK: number;
}): number {
  if (input.expectedTopK <= 0) {
    return 0;
  }

  return Number(Math.min(1, input.budgetedCount / input.expectedTopK).toFixed(2));
}

export class RetrievalOrchestrator {
  readonly #registry: SourceRegistry;
  readonly #rankerConfig?: RankerConfig;
  readonly #budgetConfig?: BudgetConfig;
  readonly #resolveCache: ResolveCache;
  readonly #checkpointStore?: CheckpointStore;
  readonly #checkpointFailureStore?: CheckpointFailureStore;
  readonly #circuitBreaker?: CircuitBreaker;
  readonly #metrics?: VegaMetricsRegistry;
  readonly #featureFlags: FeatureFlag[];
  readonly #candidateRepository?: CandidateRepository;
  readonly #promotionAuditStore?: PromotionAuditStore;
  readonly #followupCooldownMs: number;
  readonly #maxFollowups: number;
  readonly #now: () => number;

  constructor(config: OrchestratorConfig) {
    this.#registry = config.registry;
    this.#rankerConfig = config.ranker_config;
    this.#budgetConfig = config.budget_config;
    this.#resolveCache = config.resolve_cache ?? createResolveCache();
    this.#checkpointStore = config.checkpoint_store;
    this.#checkpointFailureStore = config.checkpoint_failure_store;
    this.#circuitBreaker = config.circuit_breaker;
    this.#metrics = config.metrics;
    this.#featureFlags = loadFeatureFlagRegistry(resolveFeatureFlagRegistryPath());
    this.#candidateRepository = config.candidate_repository;
    this.#promotionAuditStore = config.promotion_audit_store;
    this.#followupCooldownMs =
      config.followup_guardrails?.cooldown_ms ?? DEFAULT_FOLLOWUP_COOLDOWN_MS;
    this.#maxFollowups =
      config.followup_guardrails?.max_followups ?? DEFAULT_MAX_FOLLOWUPS;
    this.#now = config.now ?? (() => Date.now());
  }

  #errorResponse(
    checkpoint_id: string,
    reason: string,
    profile_used: string,
    ranker_version: string,
    next_retrieval_hint = "none"
  ): ContextResolveResponse {
    logger.warn("Returning retrieval error bundle", {
      checkpoint_id,
      reason,
      profile_used,
      ranker_version
    });

    return {
      checkpoint_id,
      bundle_digest: "error",
      bundle: ERROR_BUNDLE,
      sufficiency_hint: "may_need_followup",
      profile_used,
      ranker_version,
      used_sources: [],
      fallback_used: false,
      confidence: 0,
      warnings: [reason],
      next_retrieval_hint
    };
  }

  #recordFailure(input: {
    checkpoint_id: string;
    reason: string;
    request: IntentRequest;
    mode: Mode;
    profile_used: string;
    ranker_version: string;
    payload: Record<string, unknown>;
  }): void {
    if (!this.#checkpointFailureStore) {
      return;
    }

    try {
      this.#checkpointFailureStore.put({
        checkpoint_id: input.checkpoint_id,
        reason: input.reason,
        intent: input.request.intent,
        surface: input.request.surface,
        session_id: input.request.session_id,
        project: input.request.project ?? null,
        cwd: input.request.cwd ?? null,
        query_hash: createQueryHash(input.request.query ?? ""),
        mode: input.mode,
        profile_used: input.profile_used,
        ranker_version: input.ranker_version,
        payload: JSON.stringify(input.payload)
      });
    } catch (error) {
      logger.warn("CheckpointFailureStore put failed", {
        checkpoint_id: input.checkpoint_id,
        reason: input.reason,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  #finalizeResponse(
    request: Pick<IntentRequest, "intent" | "surface">,
    response: ContextResolveResponse
  ): ContextResolveResponse {
    if (isNonemptyBundle(response)) {
      this.#metrics?.recordRetrievalNonempty(request.surface, request.intent);
    }

    return response;
  }

  resolve(request: IntentRequest): ContextResolveResponse {
    this.#metrics?.recordRetrievalCall(request.surface, request.intent);

    const checkpoint_id = uuidv4();
    const traceLogger = logger.withTraceId(createTraceId());
    const profile_used = request.intent;
    const ranker_version = resolveRankerVersion(this.#rankerConfig);
    const mode = resolveMode(request);
    const breakerStatus = this.#circuitBreaker?.getStatus(request.surface);
    const breakerOpen = breakerStatus?.state === "open";
    const circuitBreakerSignal =
      breakerOpen && breakerStatus?.tripped_at !== null
        ? {
            open: true as const,
            tripped_at: breakerStatus.tripped_at,
            reasons: [...breakerStatus.reasons]
          }
        : undefined;
    let demote_ids: ReadonlySet<string> | undefined;
    let previousCheckpoint: CheckpointRecord | undefined;
    const persistCheckpoint = (response: ContextResolveResponse): boolean => {
      if (!this.#checkpointStore || response.bundle_digest === "error") {
        return false;
      }

      const record = {
        checkpoint_id: response.checkpoint_id,
        bundle_digest: response.bundle_digest,
        intent: request.intent,
        surface: request.surface,
        session_id: request.session_id,
        project: request.project ?? null,
        cwd: request.cwd ?? null,
        query_hash: createQueryHash(request.query ?? ""),
        mode,
        profile_used: response.profile_used,
        ranker_version: response.ranker_version,
        prev_checkpoint_id:
          request.intent === "followup" ? request.prev_checkpoint_id ?? null : null,
        lineage_root_checkpoint_id:
          request.intent === "followup"
            ? previousCheckpoint?.lineage_root_checkpoint_id ||
              previousCheckpoint?.checkpoint_id ||
              request.prev_checkpoint_id ||
              response.checkpoint_id
            : response.checkpoint_id,
        followup_depth:
          request.intent === "followup"
            ? (previousCheckpoint?.followup_depth ?? 0) + 1
            : 0,
        record_ids: response.bundle.sections.flatMap((section) =>
          section.records.map((record) =>
            recordKey((section.source_kind ?? section.kind) as SourceKind, record.id)
          )
        )
      };

      try {
        this.#checkpointStore.put(record);
        return true;
      } catch (error) {
        traceLogger.warn("CheckpointStore put failed", {
          checkpoint_id: response.checkpoint_id,
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    };

    if (request.intent === "followup" && !this.#checkpointStore) {
      this.#recordFailure({
        checkpoint_id,
        reason: "followup_requires_checkpoint_store",
        request,
        mode,
        profile_used,
        ranker_version,
        payload: {
          prev_checkpoint_id: request.prev_checkpoint_id ?? null,
          hint: "CheckpointStore unavailable; followup cannot be resumed. Typically happens on Postgres-backed runtimes."
        }
      });
      return this.#finalizeResponse(
        request,
        this.#errorResponse(
          checkpoint_id,
          "followup_requires_checkpoint_store",
          profile_used,
          ranker_version
        )
      );
    }

      if (request.intent !== "followup") {
        const cached = this.#resolveCache.get(request);
      if (cached !== undefined) {
        const response: ContextResolveResponse = {
          ...cached,
          checkpoint_id,
          ...(circuitBreakerSignal !== undefined
            ? {
                circuit_breaker: circuitBreakerSignal
              }
            : {})
        };
        if (persistCheckpoint(response)) {
          this.#circuitBreaker?.recordCheckpoint(request.surface);
        }
        return this.#finalizeResponse(request, response);
      }
    }

    try {
      if (request.intent === "followup" && this.#checkpointStore) {
        previousCheckpoint = this.#checkpointStore.get(request.prev_checkpoint_id!);
        const mismatch_fields = previousCheckpoint === undefined
          ? []
          : [
              ...(previousCheckpoint.session_id !== request.session_id ? ["session_id"] : []),
              ...(previousCheckpoint.surface !== request.surface ? ["surface"] : []),
              ...(previousCheckpoint.project !== (request.project ?? null) ? ["project"] : []),
              ...(previousCheckpoint.cwd !== (request.cwd ?? null) ? ["cwd"] : [])
            ];

        if (previousCheckpoint === undefined || mismatch_fields.length > 0) {
          traceLogger.warn("Previous checkpoint unavailable for followup", {
            checkpoint_id,
            prev_checkpoint_id: request.prev_checkpoint_id,
            ...(mismatch_fields.length > 0 ? { mismatch_fields } : {})
          });
          this.#recordFailure({
            checkpoint_id,
            reason:
              previousCheckpoint === undefined
                ? "prev_checkpoint_not_found"
                : "prev_checkpoint_context_mismatch",
            request,
            mode,
            profile_used,
            ranker_version,
            payload:
              previousCheckpoint === undefined
                ? {
                    prev_checkpoint_id: request.prev_checkpoint_id ?? null
                  }
                : {
                    prev_checkpoint_id: request.prev_checkpoint_id ?? null,
                    mismatch_fields
                  }
          });
          return this.#finalizeResponse(
            request,
            this.#errorResponse(
              checkpoint_id,
              "prev_checkpoint_not_found",
              profile_used,
              ranker_version
            )
          );
        }

        if (
          this.#followupCooldownMs > 0 &&
          this.#now() - previousCheckpoint.created_at < this.#followupCooldownMs
        ) {
          if (previousCheckpoint.followup_depth >= 1) {
            this.#metrics?.recordRepeatedFollowupInflation(request.surface);
          }
          return this.#finalizeResponse(
            request,
            this.#errorResponse(
              checkpoint_id,
              "followup_cooldown_active",
              profile_used,
              ranker_version
            )
          );
        }

        if (previousCheckpoint.followup_depth >= this.#maxFollowups) {
          if (previousCheckpoint.followup_depth >= 1) {
            this.#metrics?.recordRepeatedFollowupInflation(request.surface);
          }
          return this.#finalizeResponse(
            request,
            this.#errorResponse(
              checkpoint_id,
              "followup_limit_reached",
              profile_used,
              ranker_version,
              "needs_external"
            )
          );
        }

        demote_ids = new Set(previousCheckpoint.record_ids);
        if (previousCheckpoint.followup_depth >= 1) {
          this.#metrics?.recordRepeatedFollowupInflation(request.surface);
        }
      }

      const profile = getProfile(request.intent);
      const feedback = collectPromotionFeedback({
        request,
        candidateRepository: this.#candidateRepository,
        promotionAuditStore: this.#promotionAuditStore,
        previousCheckpoint
      });

      traceLogger.info("Starting retrieval orchestration", {
        intent: request.intent,
        mode,
        surface: request.surface,
        session_id: request.session_id,
        profile_used: profile.intent
      });

      const input: SourceSearchInput = {
        request,
        top_k: profile.default_top_k,
        depth: profile.default_depth
      };
      const sourcePlan = applyPromotionFeedbackToSourcePlan(
        createSourcePlan(profile, request),
        feedback
      );
      const querylessBootstrapDisabled =
        request.intent === "bootstrap" &&
        isQuerylessRequest(request) &&
        resolveFlagVariant(
          this.#featureFlags,
          RETRIEVAL_QUERYLESS_BOOTSTRAP_FLAG_ID,
          "on",
          {
            surface: request.surface,
            intent: request.intent,
            session_id: request.session_id,
            project: request.project ?? undefined
          }
        ) === "off";
      const primaryRecords = querylessBootstrapDisabled
        ? []
        : this.#registry.searchMany(sourcePlan.primary_sources, input);
      const fallbackRecords =
        primaryRecords.length === 0 && sourcePlan.fallback_sources.length > 0 && !querylessBootstrapDisabled
          ? this.#registry.searchMany(sourcePlan.fallback_sources, input)
          : [];
      const fallbackUsed = fallbackRecords.length > 0;
      const exhaustedFallback =
        primaryRecords.length === 0 &&
        sourcePlan.fallback_sources.length > 0 &&
        fallbackRecords.length === 0;
      const records = primaryRecords.length > 0 ? primaryRecords : fallbackRecords;
      const queriedSourceCount =
        sourcePlan.primary_sources.length +
        (primaryRecords.length === 0 ? sourcePlan.fallback_sources.length : 0);
      const ranked = rank(
        records,
        request,
        applyPromotionFeedbackToRankerConfig(
          this.#rankerConfig ?? DEFAULT_RANKER_CONFIG,
          feedback
        ),
        demote_ids
      ).slice(
        0,
        profile.default_top_k
      );
      const budget = applyBudget(
        ranked,
        mode,
        breakerOpen && this.#circuitBreaker
          ? applyBudgetReduction(
              resolveBudgetConfig(mode, this.#budgetConfig, request.budget_override?.tokens),
              this.#circuitBreaker.budget_reduction_factor
            )
          : resolveBudgetConfig(mode, this.#budgetConfig, request.budget_override?.tokens),
        request.intent
      );
      const classification = classifySufficiency({
        profile,
        budgeted_count: budget.budgeted.length,
        truncated_count: budget.truncated_count
      });
      const sufficiency_hint = classification.hint;
      const warnings = buildWarnings({
        fallbackUsed,
        exhaustedFallback,
        truncatedCount: budget.truncated_count,
        focus: sourcePlan.focus
      });
      const nextRetrievalHint = resolveNextRetrievalHint({
        intent: request.intent,
        hint: classification.hint,
        budgetedCount: budget.budgeted.length,
        exhaustedFallback
      });
      const confidence = resolveConfidence({
        topK: profile.default_top_k,
        budgetedCount: budget.budgeted.length,
        truncatedCount: budget.truncated_count,
        fallbackUsed
      });
      const tokenEfficiency = resolveTokenEfficiency({
        bundleTokens: budget.total_tokens,
        rawRetrievedTokens: ranked.reduce((sum, record) => sum + estimateTokens(record.content), 0)
      });
      const bundleCoverage = resolveBundleCoverage({
        budgetedCount: budget.budgeted.length,
        expectedTopK: profile.default_top_k
      });

      const assembly = assembleBundle(
        checkpoint_id,
        budget.budgeted,
        budget.truncated_count,
        budget.total_tokens,
        fallbackUsed,
        confidence,
        warnings,
        nextRetrievalHint
      );
      const sourceUtilization = resolveSourceUtilization({
        usedSourceCount: assembly.bundle.used_sources.length,
        queriedSourceCount
      });

      this.#metrics?.recordRetrievalObservability(request.surface, request.intent, {
        token_efficiency: tokenEfficiency,
        source_utilization: sourceUtilization,
        bundle_coverage: bundleCoverage
      });

      traceLogger.info("Sufficiency classified", {
        checkpoint_id,
        hint: classification.hint,
        rules_fired: classification.rules_fired,
        classifier_version: classification.classifier_version
      });

      traceLogger.info("Finished retrieval orchestration", {
        checkpoint_id,
        bundle_digest: assembly.bundle_digest,
        total_records: records.length,
        total_tokens: budget.total_tokens,
        truncated_count: budget.truncated_count
      });

      const response: ContextResolveResponse = {
        checkpoint_id,
        bundle_digest: assembly.bundle_digest,
        bundle: assembly.bundle,
        sufficiency_hint,
        profile_used: profile.intent,
        ranker_version,
        used_sources: assembly.bundle.used_sources,
        fallback_used: assembly.bundle.fallback_used,
        confidence: assembly.bundle.confidence,
        warnings: assembly.bundle.warnings,
        next_retrieval_hint: assembly.bundle.next_retrieval_hint,
        ...(circuitBreakerSignal !== undefined
          ? {
              circuit_breaker: circuitBreakerSignal
            }
          : {})
      };

      if (request.intent !== "followup" && response.bundle_digest !== "error") {
        this.#resolveCache.set(request, response);
      }

      if (persistCheckpoint(response)) {
        this.#circuitBreaker?.recordCheckpoint(request.surface);
      }
      return this.#finalizeResponse(request, response);
    } catch (error) {
      traceLogger.error("Retrieval orchestration failed", {
        intent: request.intent,
        mode,
        surface: request.surface,
        session_id: request.session_id,
        profile_used,
        error: error instanceof Error ? error.message : String(error)
      });
      this.#recordFailure({
        checkpoint_id,
        reason: "resolve_failed",
        request,
        mode,
        profile_used,
        ranker_version,
        payload: {
          error: error instanceof Error ? error.message : String(error)
        }
      });

      return this.#finalizeResponse(
        request,
        this.#errorResponse(checkpoint_id, "resolve_failed", profile_used, ranker_version)
      );
    }
  }
}
