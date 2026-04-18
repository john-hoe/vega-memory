import { createHash } from "node:crypto";

import { v4 as uuidv4 } from "uuid";

import type { Bundle } from "../core/contracts/bundle.js";
import { BUNDLE_SCHEMA } from "../core/contracts/bundle.js";
import type { CheckpointRecord } from "../core/contracts/checkpoint-record.js";
import { recordKey } from "../core/contracts/checkpoint-record.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import type { Mode } from "../core/contracts/enums.js";
import { createLogger, createTraceId } from "../core/logging/index.js";
import type { CheckpointFailureStore } from "../usage/checkpoint-failure-store.js";
import type { CheckpointStore } from "../usage/checkpoint-store.js";

import { applyBudget, type BudgetConfig, DEFAULT_BUDGET_CONFIG } from "./budget.js";
import { assembleBundle } from "./bundler.js";
import type {
  CircuitBreaker,
  CircuitBreakerTripReason
} from "./circuit-breaker.js";
import { getProfile } from "./profiles.js";
import { rank, type RankerConfig, DEFAULT_RANKER_CONFIG } from "./ranker.js";
import { createResolveCache, type ResolveCache } from "./resolve-cache.js";
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
}

export interface OrchestratorConfig {
  registry: SourceRegistry;
  ranker_config?: RankerConfig;
  budget_config?: BudgetConfig;
  resolve_cache?: ResolveCache;
  checkpoint_store?: CheckpointStore;
  checkpoint_failure_store?: CheckpointFailureStore;
  circuit_breaker?: CircuitBreaker;
}

const logger = createLogger({ name: "retrieval-orchestrator" });
const ERROR_BUNDLE = BUNDLE_SCHEMA.parse({
  schema_version: "1.0",
  bundle_digest: "error",
  sections: []
});

function resolveMode(request: IntentRequest): Mode {
  return request.mode ?? "L1";
}

function createQueryHash(query: string): string {
  return createHash("sha256").update(query).digest("hex");
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

export class RetrievalOrchestrator {
  readonly #registry: SourceRegistry;
  readonly #rankerConfig?: RankerConfig;
  readonly #budgetConfig?: BudgetConfig;
  readonly #resolveCache: ResolveCache;
  readonly #checkpointStore?: CheckpointStore;
  readonly #checkpointFailureStore?: CheckpointFailureStore;
  readonly #circuitBreaker?: CircuitBreaker;

  constructor(config: OrchestratorConfig) {
    this.#registry = config.registry;
    this.#rankerConfig = config.ranker_config;
    this.#budgetConfig = config.budget_config;
    this.#resolveCache = config.resolve_cache ?? createResolveCache();
    this.#checkpointStore = config.checkpoint_store;
    this.#checkpointFailureStore = config.checkpoint_failure_store;
    this.#circuitBreaker = config.circuit_breaker;
  }

  #errorResponse(
    checkpoint_id: string,
    reason: string,
    profile_used: string,
    ranker_version: string
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
      ranker_version
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
        query_hash: createQueryHash(input.request.query),
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

  resolve(request: IntentRequest): ContextResolveResponse {
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
    const persistCheckpoint = (response: ContextResolveResponse): boolean => {
      if (!this.#checkpointStore || response.bundle_digest === "error") {
        return false;
      }

      const record: Omit<CheckpointRecord, "created_at" | "ttl_expires_at"> = {
        checkpoint_id: response.checkpoint_id,
        bundle_digest: response.bundle_digest,
        intent: request.intent,
        surface: request.surface,
        session_id: request.session_id,
        project: request.project ?? null,
        cwd: request.cwd ?? null,
        query_hash: createQueryHash(request.query),
        mode,
        profile_used: response.profile_used,
        ranker_version: response.ranker_version,
        record_ids: response.bundle.sections.flatMap((section) =>
          section.records.map((record) => recordKey(section.source_kind, record.id))
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
      return this.#errorResponse(
        checkpoint_id,
        "followup_requires_checkpoint_store",
        profile_used,
        ranker_version
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
        return response;
      }
    }

    try {
      if (request.intent === "followup" && this.#checkpointStore) {
        const previousCheckpoint = this.#checkpointStore.get(request.prev_checkpoint_id!);
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
          return this.#errorResponse(
            checkpoint_id,
            "prev_checkpoint_not_found",
            profile_used,
            ranker_version
          );
        }

        demote_ids = new Set(previousCheckpoint.record_ids);
      }

      const profile = getProfile(request.intent);

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
      const records = this.#registry.searchMany(profile.default_sources, input);
      const ranked = rank(records, request, this.#rankerConfig, demote_ids);
      const budget = applyBudget(
        ranked,
        mode,
        breakerOpen && this.#circuitBreaker
          ? applyBudgetReduction(
              resolveBudgetConfig(mode, this.#budgetConfig, request.budget_override?.tokens),
              this.#circuitBreaker.budget_reduction_factor
            )
          : resolveBudgetConfig(mode, this.#budgetConfig, request.budget_override?.tokens)
      );
      const assembly = assembleBundle(
        budget.budgeted,
        budget.truncated_count,
        budget.total_tokens
      );
      const classification = classifySufficiency({
        profile,
        budgeted_count: budget.budgeted.length,
        truncated_count: budget.truncated_count
      });
      const sufficiency_hint = classification.hint;

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

      return response;
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

      return this.#errorResponse(checkpoint_id, "resolve_failed", profile_used, ranker_version);
    }
  }
}
