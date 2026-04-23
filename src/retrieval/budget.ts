import type { Intent, Mode } from "../core/contracts/enums.js";
import { createLogger } from "../core/logging/index.js";

import type { RankedRecord } from "./ranker.js";
import { LADDER_LEVELS, estimateTokens, ladderApply, type LadderLevel } from "./budget-ladder.js";
import { recoverHostMemoryRecords } from "./budget-reserve.js";

export interface BudgetConfig {
  max_tokens_by_mode: Record<Mode, number>;
  host_memory_file_reserved: number;
  token_multiplier_by_intent?: Partial<Record<Intent, number>>;
  ladder_levels_by_intent?: Partial<Record<Intent, LadderLevel[]>>;
}

const DEFAULT_TOKEN_MULTIPLIER_BY_INTENT: Record<Intent, number> = {
  bootstrap: 1,
  lookup: 0.75,
  followup: 0.45,
  evidence: 1
};

const DEFAULT_LADDER_LEVELS_BY_INTENT: Record<Intent, LadderLevel[]> = {
  bootstrap: ["summary", "headline", "reference"],
  lookup: ["summary", "headline", "reference"],
  followup: ["headline", "reference", "summary"],
  evidence: ["full", "summary", "headline", "reference"]
};

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  max_tokens_by_mode: {
    L0: 500,
    L1: 2000,
    L2: 6000,
    L3: 12000
  },
  // TODO(Wave 5, issue #32): raise host_memory_file_reserved when the adapter provides
  // real records and the reserve path should become active by default again.
  host_memory_file_reserved: 0,
  token_multiplier_by_intent: DEFAULT_TOKEN_MULTIPLIER_BY_INTENT,
  ladder_levels_by_intent: DEFAULT_LADDER_LEVELS_BY_INTENT
};

export type { LadderLevel };

export interface BudgetedRecord {
  record: RankedRecord;
  ladder_level: LadderLevel;
  content_used: string;
  estimated_tokens: number;
}

export interface BudgetResult {
  budgeted: BudgetedRecord[];
  total_tokens: number;
  truncated_count: number;
}

const logger = createLogger({
  name: "retrieval-budget",
  minLevel: "error"
});

function mergeConfig(config?: BudgetConfig): BudgetConfig {
  return {
    max_tokens_by_mode: {
      ...DEFAULT_BUDGET_CONFIG.max_tokens_by_mode,
      ...(config?.max_tokens_by_mode ?? {})
    },
    host_memory_file_reserved:
      config?.host_memory_file_reserved ?? DEFAULT_BUDGET_CONFIG.host_memory_file_reserved,
    token_multiplier_by_intent: {
      ...DEFAULT_TOKEN_MULTIPLIER_BY_INTENT,
      ...(config?.token_multiplier_by_intent ?? {})
    },
    ladder_levels_by_intent: {
      ...DEFAULT_LADDER_LEVELS_BY_INTENT,
      ...(config?.ladder_levels_by_intent ?? {})
    }
  };
}

export { estimateTokens, ladderApply };

export function applyBudget(
  ranked: RankedRecord[],
  mode: Mode,
  config?: BudgetConfig,
  intent: Intent = "lookup"
): BudgetResult {
  const mergedConfig = mergeConfig(config);
  const maxTokens = Math.max(
    1,
    Math.round(
      mergedConfig.max_tokens_by_mode[mode] *
        (mergedConfig.token_multiplier_by_intent?.[intent] ?? 1)
    )
  );
  const ladderLevels = mergedConfig.ladder_levels_by_intent?.[intent] ?? LADDER_LEVELS;
  const budgeted: BudgetedRecord[] = [];
  const dropped: RankedRecord[] = [];
  let totalTokens = 0;

  for (const record of ranked) {
    let accepted: BudgetedRecord | undefined;

    for (const level of ladderLevels) {
      const candidate = ladderApply(record, level);

      if (totalTokens + candidate.estimated_tokens > maxTokens) {
        continue;
      }

      accepted = {
        record,
        ladder_level: level,
        content_used: candidate.content_used,
        estimated_tokens: candidate.estimated_tokens
      };
      break;
    }

    if (accepted === undefined) {
      dropped.push(record);
      continue;
    }

    budgeted.push(accepted);
    totalTokens += accepted.estimated_tokens;
  }

  const hostTokens = budgeted
    .filter(({ record }) => record.source_kind === "host_memory_file")
    .reduce((sum, entry) => sum + entry.estimated_tokens, 0);
  const recovered = recoverHostMemoryRecords(
    dropped,
    totalTokens,
    maxTokens,
    mergedConfig.host_memory_file_reserved,
    hostTokens
  );

  if (recovered.recovered.length > 0) {
    budgeted.push(...recovered.recovered);
    totalTokens = recovered.total_tokens;
  }

  const recoveredIds = new Set(recovered.recovered.map(({ record }) => record.id));
  const finalDropped = dropped.filter((record) => !recoveredIds.has(record.id));
  const referenceOnlyCount = budgeted.filter(({ ladder_level }) => ladder_level === "reference").length;
  const truncatedCount = referenceOnlyCount + finalDropped.length;

  logger.debug("Applied retrieval budget", {
    mode,
    max_tokens: maxTokens,
    total_tokens: totalTokens,
    budgeted_count: budgeted.length,
    truncated_count: truncatedCount
  });

  return {
    budgeted,
    total_tokens: totalTokens,
    truncated_count: truncatedCount
  };
}
