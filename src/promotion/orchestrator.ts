import type {
  CandidateMemoryRecord,
  CandidateRepository
} from "../db/candidate-repository.js";
import { InvalidCandidateTypeError, Repository } from "../db/repository.js";
import type { Memory } from "../core/types.js";
import type { PromotionAuditStore } from "./audit-store.js";
import type { PromotionEvaluator } from "./evaluator.js";
import type {
  CandidateState,
  PromotionAuditState,
  PromotionCurrentState,
  PromotionDecision,
  PromotionTrigger
} from "./policy.js";

export type PromotionResultStatus = "promoted" | "demoted" | "held" | "discarded" | "kept";

export interface PromotionResult {
  status: PromotionResultStatus;
  memory_id: string;
  decision: PromotionDecision;
  audit_entry_id: string;
}

export interface PromotionOrchestratorOptions {
  evaluator: PromotionEvaluator;
  candidateRepository: CandidateRepository;
  repository: Repository;
  auditStore: PromotionAuditStore;
}

export interface PromotionOrchestrator {
  promoteManual(candidate_id: string, actor: string): PromotionResult;
  demoteManual(memory_id: string, actor: string, reason?: string): PromotionResult;
  evaluateAndAct(candidate_id: string, trigger: PromotionTrigger, actor?: string): PromotionResult;
  runSweep(actor?: string): ReadonlyArray<PromotionResult>;
}

const SWEEP_ELIGIBLE_STATES = ["pending", "held", "ready"] as const;
const SWEEP_LIST_LIMIT = 1_000_000;

function createNotFoundError(kind: "Candidate" | "Memory", id: string): Error {
  return new Error(`${kind}NotFound: ${id}`);
}

function createCandidateProjection(memory: Memory, reason?: string): CandidateMemoryRecord {
  return {
    id: memory.id,
    content: memory.content,
    type: memory.type,
    project: memory.scope === "global" ? null : memory.project,
    tags: memory.tags,
    metadata: {
      demotion_reason: reason ?? null,
      promoted_source: memory.source,
      promoted_scope: memory.scope,
      promoted_verified: memory.verified
    },
    extraction_source: "manual_demote",
    extraction_confidence: null,
    promotion_score: 0,
    visibility_gated: true,
    candidate_state: "held",
    raw_dedup_key: null,
    semantic_fingerprint: null,
    created_at: Number.isFinite(Date.parse(memory.created_at))
      ? Date.parse(memory.created_at)
      : Date.now(),
    updated_at: Number.isFinite(Date.parse(memory.updated_at))
      ? Date.parse(memory.updated_at)
      : Date.now()
  };
}

function mapDecisionToCandidateState(decision: PromotionDecision): CandidateState | undefined {
  switch (decision.action) {
    case "hold":
      return "held";
    case "discard":
      return "discarded";
    case "promote":
      return "ready";
    default:
      return undefined;
  }
}

function resolveAuditState(current_state: PromotionCurrentState, candidateState?: CandidateState): PromotionAuditState {
  if (current_state === "promoted") {
    return "promoted";
  }
  return candidateState ?? "pending";
}

export function createPromotionOrchestrator(
  options: PromotionOrchestratorOptions
): PromotionOrchestrator {
  const promoteCandidate = (
    candidate: CandidateMemoryRecord,
    decision: PromotionDecision,
    trigger: PromotionTrigger,
    actor: string | undefined
  ): PromotionResult => {
    try {
      const auditEntry = options.repository.db.transaction(() => {
        // NOTE: candidate.metadata / extraction_source / extraction_confidence
        // are intentionally dropped on promotion — the promoted memories schema
        // does not carry these fields, and audit records lifecycle info in
        // promotion_audit separately. If forensic preservation of candidate
        // state becomes required, add a `from_snapshot` column to the audit
        // table rather than extending the promoted schema.
        options.repository.createFromCandidate(candidate.id, {
          content: candidate.content,
          type: candidate.type,
          project: candidate.project,
          tags: candidate.tags
        }, {
          surface: "vega_internal",
          session_id: null,
          actor: actor ?? null,
          trigger
        });

        if (!options.candidateRepository.delete(candidate.id)) {
          throw new Error(`Failed to delete promoted candidate ${candidate.id}`);
        }

        return options.auditStore.put({
          memory_id: candidate.id,
          action: "promote",
          trigger,
          from_state: candidate.candidate_state,
          to_state: "promoted",
          policy_name: decision.policy_name,
          policy_version: decision.policy_version,
          reason: decision.reason,
          actor: actor ?? null
        });
      });

      return {
        status: "promoted",
        memory_id: candidate.id,
        decision,
        audit_entry_id: auditEntry.id
      };
    } catch (error) {
      if (!(error instanceof InvalidCandidateTypeError)) {
        throw error;
      }

      const keptDecision: PromotionDecision = {
        ...decision,
        action: "keep",
        reason: "invalid_type"
      };
      const auditEntry = options.auditStore.put({
        memory_id: candidate.id,
        action: "keep",
        trigger,
        from_state: candidate.candidate_state,
        to_state: candidate.candidate_state,
        policy_name: decision.policy_name,
        policy_version: decision.policy_version,
        reason: keptDecision.reason,
        actor: actor ?? null
      });

      return {
        status: "kept",
        memory_id: candidate.id,
        decision: keptDecision,
        audit_entry_id: auditEntry.id
      };
    }
  };

  return {
    promoteManual(candidate_id, actor) {
      const candidate = options.candidateRepository.findById(candidate_id);

      if (candidate === undefined) {
        throw createNotFoundError("Candidate", candidate_id);
      }

      const decision = options.evaluator.evaluate(candidate, "manual", actor, "candidate");

      if (decision.action !== "promote") {
        throw new Error(`PromotionDenied: ${decision.reason}`);
      }

      return promoteCandidate(candidate, decision, "manual", actor);
    },
    demoteManual(memory_id, actor, reason) {
      const memory = options.repository.getMemory(memory_id);

      if (memory === null) {
        throw createNotFoundError("Memory", memory_id);
      }

      const projectedCandidate = createCandidateProjection(memory, reason);
      const decision = options.evaluator.evaluate(
        projectedCandidate,
        "manual",
        actor,
        "promoted"
      );

      if (decision.action !== "demote") {
        throw new Error(`DemotionDenied: ${decision.reason}`);
      }

      const auditEntry = options.repository.db.transaction(() => {
        options.candidateRepository.create({
          id: memory.id,
          content: memory.content,
          type: memory.type,
          project: memory.scope === "global" ? null : memory.project,
          tags: memory.tags,
          metadata: projectedCandidate.metadata,
          extraction_source: "manual_demote",
          extraction_confidence: null,
          visibility_gated: true,
          candidate_state: "held"
        });

        if (!options.repository.demoteToCandidate(memory.id)) {
          throw new Error(`Failed to demote promoted memory ${memory.id}`);
        }

        return options.auditStore.put({
          memory_id: memory.id,
          action: "demote",
          trigger: "manual",
          from_state: "promoted",
          to_state: "held",
          policy_name: decision.policy_name,
          policy_version: decision.policy_version,
          reason: reason ?? decision.reason,
          actor
        });
      });

      return {
        status: "demoted",
        memory_id: memory.id,
        decision: {
          ...decision,
          reason: reason ?? decision.reason
        },
        audit_entry_id: auditEntry.id
      };
    },
    evaluateAndAct(candidate_id, trigger, actor) {
      const candidate = options.candidateRepository.findById(candidate_id);

      if (candidate === undefined) {
        throw createNotFoundError("Candidate", candidate_id);
      }

      const decision = options.evaluator.evaluate(candidate, trigger, actor, "candidate");

      if (decision.action === "promote" && trigger !== "policy") {
        return promoteCandidate(candidate, decision, trigger, actor);
      }

      if (decision.action === "demote") {
        throw new Error("InvalidPromotionDecision: demote is only valid for promoted memories");
      }

      const nextState = mapDecisionToCandidateState(decision);
      const auditEntry = options.repository.db.transaction(() => {
        if (
          nextState !== undefined &&
          !options.candidateRepository.updateState(candidate.id, nextState)
        ) {
          throw new Error(`Failed to update candidate state for ${candidate.id}`);
        }

        const fromState = candidate.candidate_state;
        const toState = resolveAuditState("candidate", nextState ?? candidate.candidate_state);

        return options.auditStore.put({
          memory_id: candidate.id,
          action: decision.action,
          trigger,
          from_state: fromState,
          to_state: toState,
          policy_name: decision.policy_name,
          policy_version: decision.policy_version,
          reason: decision.reason,
          actor: actor ?? null
        });
      });

      return {
        status:
          decision.action === "discard"
            ? "discarded"
            : decision.action === "hold"
              ? "held"
              : "kept",
        memory_id: candidate.id,
        decision,
        audit_entry_id: auditEntry.id
      };
    },
    runSweep(actor = "system") {
      return SWEEP_ELIGIBLE_STATES
        .flatMap((state) =>
          options.candidateRepository.list({
            state,
            limit: SWEEP_LIST_LIMIT
          })
        )
        .sort((left, right) => right.created_at - left.created_at)
        .map((candidate) => this.evaluateAndAct(candidate.id, "sweep", actor));
    }
  };
}
