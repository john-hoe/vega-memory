import { ladderApply, type LadderLevel } from "./budget-ladder.js";
import type { RankedRecord } from "./ranker.js";

import type { BudgetedRecord } from "./budget.js";

interface ReserveResult {
  recovered: BudgetedRecord[];
  total_tokens: number;
}

const RECOVERY_LEVELS: LadderLevel[] = ["headline", "reference"];

export function recoverHostMemoryRecords(
  dropped: RankedRecord[],
  totalTokens: number,
  maxTokens: number,
  reservedTokens: number,
  existingHostTokens: number
): ReserveResult {
  if (existingHostTokens >= reservedTokens || totalTokens >= maxTokens) {
    return { recovered: [], total_tokens: totalTokens };
  }

  let nextTotalTokens = totalTokens;
  let hostTokens = existingHostTokens;
  const recovered: BudgetedRecord[] = [];

  for (const record of dropped) {
    if (record.source_kind !== "host_memory_file" || hostTokens >= reservedTokens) {
      continue;
    }

    for (const level of RECOVERY_LEVELS) {
      const candidate = ladderApply(record, level);

      if (nextTotalTokens + candidate.estimated_tokens > maxTokens) {
        continue;
      }

      recovered.push({
        record,
        ladder_level: level,
        content_used: candidate.content_used,
        estimated_tokens: candidate.estimated_tokens
      });
      nextTotalTokens += candidate.estimated_tokens;
      hostTokens += candidate.estimated_tokens;
      break;
    }
  }

  return {
    recovered,
    total_tokens: nextTotalTokens
  };
}
