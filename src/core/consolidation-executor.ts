import type { VegaConfig } from "../config.js";
import type { Repository } from "../db/repository.js";
import type { CompactService } from "./compact.js";
import type { MemoryService } from "./memory.js";
import type {
  ConsolidationCandidate,
  ConsolidationCandidateAction,
  ConsolidationExecutionResult,
  ConsolidationPolicy
} from "./types.js";

const AUTO_EXECUTABLE_ACTIONS: ReadonlySet<ConsolidationCandidateAction> = new Set([
  "archive",
  "mark_expired"
]);

export class ConsolidationExecutor {
  constructor(
    private readonly repository: Repository,
    private readonly memoryService: MemoryService,
    private readonly compactService: CompactService,
    private readonly config: VegaConfig
  ) {}

  execute(
    candidates: ConsolidationCandidate[],
    policy: ConsolidationPolicy
  ): ConsolidationExecutionResult {
    void this.memoryService;
    void this.compactService;
    void this.config;

    const result: ConsolidationExecutionResult = {
      executed: [],
      skipped_high_risk: 0,
      skipped_no_approval: 0
    };
    const approvedActions = new Set(policy.auto_actions);

    candidates.forEach((candidate, candidateIndex) => {
      if (candidate.risk === "high") {
        result.skipped_high_risk += 1;
        return;
      }

      if (!approvedActions.has(candidate.action)) {
        result.skipped_no_approval += 1;
        return;
      }

      try {
        switch (candidate.action) {
          case "archive": {
            for (const memoryId of candidate.memory_ids) {
              this.repository.updateMemory(memoryId, {
                status: "archived",
                updated_at: new Date().toISOString()
              });
            }

            result.executed.push({
              candidate_index: candidateIndex,
              action: candidate.action,
              success: true,
              details: `Archived ${candidate.memory_ids.length} memory record(s)`
            });
            return;
          }
          case "mark_expired": {
            for (const factClaimId of candidate.fact_claim_ids) {
              this.repository.updateFactClaimStatus(
                factClaimId,
                "suspected_expired",
                "Auto-marked by consolidation auto_low_risk executor"
              );
            }

            result.executed.push({
              candidate_index: candidateIndex,
              action: candidate.action,
              success: true,
              details: `Marked ${candidate.fact_claim_ids.length} fact claim(s) as suspected_expired`
            });
            return;
          }
          case "synthesize_wiki":
            result.executed.push({
              candidate_index: candidateIndex,
              action: candidate.action,
              success: false,
              details: "Recommended only; wiki synthesis remains manual"
            });
            return;
          case "promote_global":
            result.executed.push({
              candidate_index: candidateIndex,
              action: candidate.action,
              success: false,
              details: "Recommended only; global promotion requires review"
            });
            return;
          case "merge":
            result.executed.push({
              candidate_index: candidateIndex,
              action: candidate.action,
              success: false,
              details: "Recommended only; merge is not auto-executed in low-risk mode"
            });
            return;
          case "review_conflict":
            result.executed.push({
              candidate_index: candidateIndex,
              action: candidate.action,
              success: false,
              details: "Recommended only; conflicts always require human review"
            });
            return;
        }
      } catch (error) {
        result.executed.push({
          candidate_index: candidateIndex,
          action: candidate.action,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    return result;
  }
}

export const isAutoExecutableConsolidationAction = (
  action: ConsolidationCandidateAction
): boolean => AUTO_EXECUTABLE_ACTIONS.has(action);
