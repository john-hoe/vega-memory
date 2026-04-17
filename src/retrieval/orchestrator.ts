import { v4 as uuidv4 } from "uuid";

import type { Bundle } from "../core/contracts/bundle.js";
import { BUNDLE_SCHEMA } from "../core/contracts/bundle.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import type { Mode } from "../core/contracts/enums.js";
import { createLogger, createTraceId } from "../core/logging/index.js";

import { applyBudget, type BudgetConfig, DEFAULT_BUDGET_CONFIG } from "./budget.js";
import { assembleBundle } from "./bundler.js";
import { getProfile } from "./profiles.js";
import { rank, type RankerConfig, DEFAULT_RANKER_CONFIG } from "./ranker.js";
import type { SourceRegistry } from "./sources/registry.js";
import type { SourceSearchInput } from "./sources/types.js";

export interface ContextResolveResponse {
  checkpoint_id: string;
  bundle_digest: string;
  bundle: Bundle;
  sufficiency_hint?: "likely_sufficient" | "may_need_followup";
  profile_used: string;
  ranker_version: string;
}

export interface OrchestratorConfig {
  registry: SourceRegistry;
  ranker_config?: RankerConfig;
  budget_config?: BudgetConfig;
}

const logger = createLogger({ name: "retrieval-orchestrator" });
const ERROR_BUNDLE = BUNDLE_SCHEMA.parse({
  bundle_digest: "error",
  sections: []
});

function resolveMode(request: IntentRequest): Mode {
  return request.mode ?? "L1";
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

export class RetrievalOrchestrator {
  readonly #registry: SourceRegistry;
  readonly #rankerConfig?: RankerConfig;
  readonly #budgetConfig?: BudgetConfig;

  constructor(config: OrchestratorConfig) {
    this.#registry = config.registry;
    this.#rankerConfig = config.ranker_config;
    this.#budgetConfig = config.budget_config;
  }

  resolve(request: IntentRequest): ContextResolveResponse {
    const checkpoint_id = uuidv4();
    const traceLogger = logger.withTraceId(createTraceId());
    const profile_used = request.intent;
    const ranker_version = resolveRankerVersion(this.#rankerConfig);
    const mode = resolveMode(request);

    try {
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
      const ranked = rank(records, request, this.#rankerConfig);
      const budget = applyBudget(
        ranked,
        mode,
        resolveBudgetConfig(mode, this.#budgetConfig, request.budget_override?.tokens)
      );
      const assembly = assembleBundle(
        budget.budgeted,
        budget.truncated_count,
        budget.total_tokens
      );
      const sufficiency_hint =
        budget.truncated_count === 0 && budget.budgeted.length >= profile.default_top_k
          ? "likely_sufficient"
          : "may_need_followup";

      traceLogger.info("Finished retrieval orchestration", {
        checkpoint_id,
        bundle_digest: assembly.bundle_digest,
        total_records: records.length,
        total_tokens: budget.total_tokens,
        truncated_count: budget.truncated_count
      });

      return {
        checkpoint_id,
        bundle_digest: assembly.bundle_digest,
        bundle: assembly.bundle,
        sufficiency_hint,
        profile_used: profile.intent,
        ranker_version
      };
    } catch (error) {
      traceLogger.error("Retrieval orchestration failed", {
        intent: request.intent,
        mode,
        surface: request.surface,
        session_id: request.session_id,
        profile_used,
        error: error instanceof Error ? error.message : String(error)
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
  }
}
