import type { CandidateMemoryRecord } from "../db/candidate-repository.js";
import type { AckRecord } from "../usage/ack-store.js";
import {
  createJudgmentRules,
  mergeJudgmentRules,
  DEFAULT_JUDGMENT_RULES,
  type JudgmentRules,
  type JudgmentRulesOverride
} from "./judgment-rules.js";

export type PromotionAction = "promote" | "hold" | "discard" | "keep" | "demote";
export type PromotionTrigger = "manual" | "policy" | "sweep";

/** Candidate lifecycle states stored in the candidate table. */
export type CandidateState = "pending" | "held" | "ready" | "discarded";

/** Audit vocabulary for the from/to states of a promotion decision.
 *  Includes the candidate lifecycle states plus the promoted state. */
export type PromotionAuditState = CandidateState | "promoted";

/** Current state used by the policy evaluator.
 *  "candidate" means any candidate lifecycle state; "promoted" means already promoted. */
export type PromotionCurrentState = "candidate" | "promoted";

export interface PromotionDecision {
  action: PromotionAction;
  reason: string;
  policy_name: string;
  policy_version: string;
}

export interface PromotionContext {
  candidate: CandidateMemoryRecord;
  current_state: PromotionCurrentState;
  trigger: PromotionTrigger;
  now: number;
  ack_history?: ReadonlyArray<AckRecord>;
}

export interface PromotionRule {
  name: string;
  version: string;
  evaluate(ctx: PromotionContext): PromotionDecision | undefined;
}

export interface PromotionPolicy {
  name: string;
  version: string;
  decide(ctx: PromotionContext): PromotionDecision;
}

export const DEFAULT_POLICY_NAME = "default";
export const DEFAULT_POLICY_VERSION = "v1";

function createDecision(action: PromotionAction, reason: string): PromotionDecision {
  return {
    action,
    reason,
    policy_name: DEFAULT_POLICY_NAME,
    policy_version: DEFAULT_POLICY_VERSION
  };
}

function createManualRule(): PromotionRule {
  return {
    name: "manual",
    version: DEFAULT_POLICY_VERSION,
    evaluate(ctx) {
      if (ctx.trigger !== "manual") {
        return undefined;
      }

      if (ctx.current_state === "promoted") {
        return createDecision("demote", "Manual trigger requested demotion.");
      }

      return createDecision("promote", "Manual trigger requested promotion.");
    }
  };
}

function createDiscardedRule(): PromotionRule {
  return {
    name: "discarded",
    version: DEFAULT_POLICY_VERSION,
    evaluate(ctx) {
      // Discarded candidates are terminal for sweep and are excluded there.
      // Keep this rule so direct evaluations remain idempotent.
      if (ctx.candidate.candidate_state !== "discarded") {
        return undefined;
      }

      return createDecision("keep", "Discarded candidates stay out of promotion flow.");
    }
  };
}

function createAgeRule(ageThresholdMs: number): PromotionRule {
  return {
    name: "age",
    version: DEFAULT_POLICY_VERSION,
    evaluate(ctx) {
      if (ctx.current_state !== "candidate") {
        return undefined;
      }

      if (ctx.candidate.created_at + ageThresholdMs > ctx.now) {
        return undefined;
      }

      return createDecision("promote", "Candidate age threshold reached.");
    }
  };
}

function createAckRule(
  minSufficientAcks: number,
  minDistinctSessions: number
): PromotionRule {
  return {
    name: "ack",
    version: DEFAULT_POLICY_VERSION,
    evaluate(ctx) {
      if (ctx.current_state !== "candidate" || ctx.ack_history === undefined) {
        return undefined;
      }

      const lineageBoundAcks = ctx.ack_history.filter(
        (ack) => ack.sufficiency === "sufficient"
      );
      const distinctSessions = new Set(
        lineageBoundAcks.flatMap((ack) => (ack.session_id === null ? [] : [ack.session_id]))
      );

      if (
        lineageBoundAcks.length < minSufficientAcks ||
        distinctSessions.size < minDistinctSessions
      ) {
        return undefined;
      }

      return createDecision(
        "promote",
        "Sufficient acknowledgment threshold reached across distinct sessions."
      );
    }
  };
}

export function createDefaultPromotionPolicy(
  overrides: import("./judgment-rules.js").JudgmentRulesOverride = {}
): PromotionPolicy {
  const judgmentRules = createJudgmentRules(overrides);
  const rules: PromotionRule[] = [
    createManualRule(),
    createDiscardedRule(),
    createAgeRule(judgmentRules.rules.age_threshold_ms),
    createAckRule(
      judgmentRules.rules.min_sufficient_acks,
      judgmentRules.rules.min_distinct_sessions
    )
  ];

  return {
    name: DEFAULT_POLICY_NAME,
    version: DEFAULT_POLICY_VERSION,
    decide(ctx) {
      for (const rule of rules) {
        const decision = rule.evaluate(ctx);

        if (decision !== undefined) {
          return decision;
        }
      }

      return createDecision("hold", "Candidate remains on hold.");
    }
  };
}

export { createJudgmentRules, mergeJudgmentRules, DEFAULT_JUDGMENT_RULES };
export type { JudgmentRules, JudgmentRulesOverride };
