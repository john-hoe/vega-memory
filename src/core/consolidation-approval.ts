import { randomUUID } from "node:crypto";

import type { Repository } from "../db/repository.js";
import type {
  ApprovalDecision,
  ApprovalItem,
  ConsolidationCandidateAction,
  ConsolidationCandidate,
  FactClaim,
  Memory,
  MemoryTopic
} from "./types.js";

const now = (): string => new Date().toISOString();

const AUTO_EXECUTABLE_APPROVAL_ACTIONS = new Set([
  "merge",
  "review_conflict",
  "mark_expired",
  "archive"
] as const);

const isAutoExecutableApprovalAction = (
  action: ConsolidationCandidateAction
): boolean =>
  AUTO_EXECUTABLE_APPROVAL_ACTIONS.has(
    action as (typeof AUTO_EXECUTABLE_APPROVAL_ACTIONS extends Set<infer T> ? T : never)
  );

const unique = (values: string[]): string[] => [...new Set(values)];

const appendReviewComment = (
  current: string | null,
  addition: string
): string => (current === null || current.trim().length === 0 ? addition : `${current}\n${addition}`);

const formatExecutionFailureComment = (error: string): string =>
  `[execution_failed: ${error}]`;

const formatRetrySuccessComment = (retriedBy: string): string =>
  `[retried: success by ${retriedBy}]`;

const formatRetryFailureComment = (error: string): string =>
  `[retry_failed: ${error}]`;

const formatExecuteSuccessComment = (executedBy: string, details?: string): string =>
  details && details.trim().length > 0
    ? `[executed: success by ${executedBy}] ${details}`
    : `[executed: success by ${executedBy}]`;

const clearExecutionFailureComment = (comment: string | null): string | null => {
  if (comment === null) {
    return null;
  }

  const cleaned = comment.replace(/\s*\[execution_failed:.*?\]/g, "").trim();
  return cleaned.length === 0 ? null : cleaned;
};

const mergeContent = (newer: string, older: string): string => {
  const recent = newer.trim();
  const previous = older.trim();

  if (recent.includes(previous)) {
    return newer;
  }

  if (previous.includes(recent)) {
    return older;
  }

  return `${recent}\n\n${previous}`;
};

const compareMemoryRecency = (left: Memory, right: Memory): number => {
  const leftUpdated = Date.parse(left.updated_at);
  const rightUpdated = Date.parse(right.updated_at);

  if (leftUpdated !== rightUpdated) {
    return leftUpdated - rightUpdated;
  }

  const leftCreated = Date.parse(left.created_at);
  const rightCreated = Date.parse(right.created_at);

  if (leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }

  return left.id.localeCompare(right.id);
};

const claimIdentity = (claim: Pick<
  FactClaim,
  "canonical_key" | "valid_from" | "valid_to" | "temporal_precision"
>): string =>
  [
    claim.canonical_key,
    claim.valid_from,
    claim.valid_to ?? "",
    claim.temporal_precision
  ].join("\u0000");

const resolveClaimSource = (
  sourceMemoryId: string | null,
  evidenceArchiveId: string | null,
  currentSource: FactClaim["source"]
): FactClaim["source"] => {
  if (currentSource === "manual") {
    return "manual";
  }

  if (sourceMemoryId !== null && evidenceArchiveId !== null) {
    return "mixed";
  }

  if (evidenceArchiveId !== null) {
    return "raw_archive";
  }

  if (sourceMemoryId !== null) {
    return "hot_memory";
  }

  return currentSource;
};

const mergeTopicSource = (
  left: MemoryTopic["source"],
  right: MemoryTopic["source"]
): MemoryTopic["source"] => (left === "explicit" || right === "explicit" ? "explicit" : "auto");

const mergeTopicConfidence = (
  existing: MemoryTopic,
  incoming: MemoryTopic
): MemoryTopic["confidence"] => {
  const source = mergeTopicSource(existing.source, incoming.source);

  if (source === "explicit") {
    return null;
  }

  if (existing.confidence === null) {
    return incoming.confidence;
  }

  if (incoming.confidence === null) {
    return existing.confidence;
  }

  return Math.max(existing.confidence, incoming.confidence);
};

export class ConsolidationApprovalService {
  constructor(private readonly repository: Repository) {}

  submitForApproval(
    runId: string,
    candidate: ConsolidationCandidate,
    project: string,
    tenantId?: string | null
  ): ApprovalItem {
    const createdAt = now();
    const item: Omit<ApprovalItem, "updated_at"> = {
      id: randomUUID(),
      run_id: runId,
      project,
      tenant_id: tenantId ?? null,
      candidate_kind: candidate.kind,
      candidate_action: candidate.action,
      candidate_risk: candidate.risk,
      memory_ids: [...candidate.memory_ids],
      fact_claim_ids: [...candidate.fact_claim_ids],
      description: candidate.description,
      evidence: [...candidate.evidence],
      score: candidate.score,
      status: "pending",
      reviewed_by: null,
      reviewed_at: null,
      review_comment: null,
      executed_at: null,
      created_at: createdAt
    };

    this.repository.insertApprovalItem(item);
    this.repository.logAudit({
      timestamp: createdAt,
      actor: "system",
      action: "consolidation_approval_submitted",
      memory_id: candidate.memory_ids[0] ?? null,
      detail: JSON.stringify({
        approval_id: item.id,
        run_id: runId,
        candidate_kind: candidate.kind,
        candidate_action: candidate.action,
        candidate_risk: candidate.risk,
        project,
        tenant_id: tenantId ?? null
      }),
      ip: null,
      tenant_id: tenantId ?? null
    });

    return this.requireApprovalItem(item.id);
  }

  submitCandidates(
    runId: string,
    candidates: ConsolidationCandidate[],
    project: string,
    tenantId?: string | null
  ): ApprovalItem[] {
    return candidates
      .filter((candidate) => candidate.risk === "medium" || candidate.risk === "high")
      .map((candidate) => this.submitForApproval(runId, candidate, project, tenantId));
  }

  review(decision: ApprovalDecision, auto_execute = false): ApprovalItem {
    const existing = this.requireApprovalItem(decision.item_id);

    if (existing.status !== "pending") {
      throw new Error(`Approval item ${decision.item_id} is already ${existing.status}`);
    }

    const reviewedAt = now();
    let execution:
      | { success: boolean; error?: string; details?: string }
      | undefined;

    if (
      auto_execute &&
      decision.status === "approved" &&
      isAutoExecutableApprovalAction(existing.candidate_action)
    ) {
      this.repository.updateApprovalItem(decision.item_id, {
        status: "approved_pending_execution",
        reviewed_by: decision.reviewed_by,
        reviewed_at: reviewedAt,
        review_comment: decision.comment ?? null
      });

      execution = this.executeApproved(this.requireApprovalItem(decision.item_id));
      this.repository.updateApprovalItem(decision.item_id, {
        status: execution.success ? "approved" : "execution_failed",
        reviewed_by: decision.reviewed_by,
        reviewed_at: reviewedAt,
        review_comment: execution.success
          ? appendReviewComment(decision.comment ?? null, "[executed]")
          : appendReviewComment(
              decision.comment ?? null,
              formatExecutionFailureComment(execution.error ?? "unknown error")
            ),
        executed_at: execution.success ? new Date().toISOString() : null
      });
    } else {
      this.repository.updateApprovalItem(decision.item_id, {
        status: decision.status,
        reviewed_by: decision.reviewed_by,
        reviewed_at: reviewedAt,
        review_comment: decision.comment ?? null
      });
    }

    const updated = this.requireApprovalItem(decision.item_id);
    this.repository.logAudit({
      timestamp: reviewedAt,
      actor: decision.reviewed_by,
      action: "consolidation_approval_reviewed",
      memory_id: updated.memory_ids[0] ?? null,
      detail: JSON.stringify({
        approval_id: updated.id,
        status: updated.status,
        auto_execute,
        comment: updated.review_comment,
        execution:
          execution === undefined
            ? null
            : {
                success: execution.success,
                error: execution.error ?? null,
                details: execution.details ?? null
              }
      }),
      ip: null,
      tenant_id: updated.tenant_id
    });

    return updated;
  }

  retry(itemId: string, retriedBy: string): ApprovalItem {
    const existing = this.requireApprovalItem(itemId);

    if (existing.status !== "execution_failed") {
      throw new Error(`Approval item ${itemId} is ${existing.status}; only execution_failed items can be retried`);
    }

    const retriedAt = now();
    this.repository.updateApprovalItem(itemId, {
      status: "approved_pending_execution",
      reviewed_by: retriedBy,
      reviewed_at: retriedAt,
      review_comment: existing.review_comment
    });

    const execution = this.executeApproved(this.requireApprovalItem(itemId));
    const updatedComment = execution.success
      ? appendReviewComment(
          clearExecutionFailureComment(existing.review_comment),
          formatRetrySuccessComment(retriedBy)
        )
      : appendReviewComment(
          existing.review_comment,
          formatRetryFailureComment(execution.error ?? "unknown error")
        );

    this.repository.updateApprovalItem(itemId, {
      status: execution.success ? "approved" : "execution_failed",
      reviewed_by: retriedBy,
      reviewed_at: retriedAt,
      review_comment: updatedComment,
      executed_at: execution.success ? new Date().toISOString() : null
    });

    const updated = this.requireApprovalItem(itemId);
    this.repository.logAudit({
      timestamp: retriedAt,
      actor: retriedBy,
      action: "consolidation_approval_retried",
      memory_id: updated.memory_ids[0] ?? null,
      detail: JSON.stringify({
        approval_id: updated.id,
        previous_status: existing.status,
        status: updated.status,
        success: execution.success,
        error: execution.error ?? null,
        details: execution.details ?? null
      }),
      ip: null,
      tenant_id: updated.tenant_id
    });

    return updated;
  }

  execute(itemId: string, executedBy: string): ApprovalItem {
    const existing = this.requireApprovalItem(itemId);

    if (existing.status !== "approved") {
      throw new Error(`Approval item ${itemId} is ${existing.status}; only approved items can be executed`);
    }

    const executedAt = now();
    this.repository.updateApprovalItem(itemId, {
      status: "approved_pending_execution",
      reviewed_by: executedBy,
      reviewed_at: executedAt,
      review_comment: existing.review_comment
    });

    const execution = this.executeApproved(this.requireApprovalItem(itemId));
    const updatedComment = execution.success
      ? appendReviewComment(
          existing.review_comment,
          formatExecuteSuccessComment(executedBy, execution.details)
        )
      : appendReviewComment(
          existing.review_comment,
          formatExecutionFailureComment(execution.error ?? "unknown error")
        );

    this.repository.updateApprovalItem(itemId, {
      status: execution.success ? "approved" : "execution_failed",
      reviewed_by: executedBy,
      reviewed_at: executedAt,
      review_comment: updatedComment,
      executed_at: execution.success ? new Date().toISOString() : null
    });

    const updated = this.requireApprovalItem(itemId);
    this.repository.logAudit({
      timestamp: executedAt,
      actor: executedBy,
      action: "consolidation_approval_execute_requested",
      memory_id: updated.memory_ids[0] ?? null,
      detail: JSON.stringify({
        approval_id: updated.id,
        previous_status: existing.status,
        status: updated.status,
        success: execution.success,
        error: execution.error ?? null,
        details: execution.details ?? null
      }),
      ip: null,
      tenant_id: updated.tenant_id
    });

    return updated;
  }

  listPending(project: string, tenantId?: string | null, limit = 100): ApprovalItem[] {
    return this.repository.listApprovalItems(project, "pending", tenantId, limit);
  }

  listAll(
    project: string,
    status?: ApprovalItem["status"],
    tenantId?: string | null,
    limit = 100
  ): ApprovalItem[] {
    return this.repository.listApprovalItems(project, status, tenantId, limit);
  }

  getPendingCount(project: string, tenantId?: string | null): number {
    return this.repository.countPendingApprovals(project, tenantId);
  }

  expirePendingForRunPrefix(runIdPrefix: string): number {
    const pending = this.repository.listApprovalItemsByRunPrefix(runIdPrefix, "pending");

    if (pending.length === 0) {
      return 0;
    }

    const expiredAt = now();

    for (const item of pending) {
      this.repository.updateApprovalItem(item.id, {
        status: "expired",
        reviewed_by: "system",
        reviewed_at: expiredAt,
        review_comment: "superseded by retry"
      });
    }

    return pending.length;
  }

  executeApproved(item: ApprovalItem): { success: boolean; error?: string; details?: string } {
    if (item.status !== "approved" && item.status !== "approved_pending_execution") {
      return {
        success: false,
        error: `Approval item ${item.id} must be approved before execution`
      };
    }

    try {
      switch (item.candidate_action) {
        case "merge":
          return this.executeMerge(item);
        case "review_conflict":
          return this.executeConflictReview(item);
        case "mark_expired":
          return this.executeMarkExpired(item);
        case "archive":
          return this.executeArchive(item);
        default:
          return {
            success: false,
            error: `Unsupported approval execution action: ${item.candidate_action}`
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private executeMerge(
    item: ApprovalItem
  ): { success: boolean; error?: string; details?: string } {
    const memories = this.repository.getMemoriesByIds(item.memory_ids);

    if (memories.length !== item.memory_ids.length) {
      return {
        success: false,
        error: "Merge candidate references memory records that no longer exist"
      };
    }

    if (memories.length < 2) {
      return {
        success: false,
        error: "Merge candidate requires at least two memories"
      };
    }

    const activeMemories = memories.filter((memory) => memory.status === "active");

    if (activeMemories.length !== memories.length) {
      return {
        success: false,
        error: "Merge candidate references archived memories"
      };
    }

    const sorted = [...activeMemories].sort(compareMemoryRecency);
    const kept = sorted[sorted.length - 1];
    const merged = sorted.slice(0, -1);
    const mergedAt = now();
    const activeKeptClaims = new Set(
      this.repository
        .listFactClaimsBySourceMemoryId(kept.id)
        .filter((claim) => claim.status === "active")
        .map(claimIdentity)
    );
    let mergedContentValue = kept.content;
    let mergedImportance = kept.importance;
    let mergedTags = [...kept.tags];
    let mergedProjects = [...kept.accessed_projects];
    let relinkedClaims = 0;
    let suspectedClaims = 0;
    let migratedTopics = 0;

    for (const memory of merged) {
      mergedContentValue = mergeContent(mergedContentValue, memory.content);
      mergedImportance = Math.max(mergedImportance, memory.importance);
      mergedTags = unique([...mergedTags, ...memory.tags]);
      mergedProjects = unique([...mergedProjects, ...memory.accessed_projects]);
    }

    this.repository.db.transaction(() => {
      this.repository.updateMemory(kept.id, {
        content: mergedContentValue,
        embedding: null,
        importance: mergedImportance,
        tags: mergedTags,
        updated_at: mergedAt,
        accessed_projects: mergedProjects
      });

      for (const memory of merged) {
        for (const claim of this.repository.listFactClaimsBySourceMemoryId(memory.id)) {
          this.repository.updateFactClaimProvenance(claim.id, {
            source_memory_id: kept.id,
            evidence_archive_id: claim.evidence_archive_id,
            source: resolveClaimSource(kept.id, claim.evidence_archive_id, claim.source),
            updated_at: mergedAt
          });
          relinkedClaims += 1;

          if (claim.status !== "active") {
            continue;
          }

          const identity = claimIdentity(claim);
          if (activeKeptClaims.has(identity)) {
            this.repository.updateFactClaimStatus(
              claim.id,
              "suspected_expired",
              `Duplicate claim consolidated during approved merge into memory ${kept.id}.`
            );
            suspectedClaims += 1;
            continue;
          }

          activeKeptClaims.add(identity);
        }

        for (const assignment of this.repository.listMemoryTopicsByMemoryId(memory.id, "active")) {
          const existing = this.repository.getMemoryTopic(kept.id, assignment.topic_id);

          if (existing) {
            this.repository.updateMemoryTopic(kept.id, assignment.topic_id, {
              source: mergeTopicSource(existing.source, assignment.source),
              confidence: mergeTopicConfidence(existing, assignment),
              status: "active",
              updated_at: mergedAt
            });
          } else {
            this.repository.createMemoryTopic({
              memory_id: kept.id,
              topic_id: assignment.topic_id,
              source: assignment.source,
              confidence: assignment.confidence,
              status: "active",
              created_at: assignment.created_at,
              updated_at: mergedAt
            });
          }

          this.repository.updateMemoryTopic(memory.id, assignment.topic_id, {
            status: "superseded",
            updated_at: mergedAt
          });
          migratedTopics += 1;
        }

        this.repository.updateMemory(memory.id, {
          status: "archived",
          updated_at: mergedAt
        });
      }
    });

    this.repository.logAudit({
      timestamp: mergedAt,
      actor: item.reviewed_by ?? "system",
      action: "consolidation_approval_executed",
      memory_id: kept.id,
      detail: JSON.stringify({
        approval_id: item.id,
        action: item.candidate_action,
        kept_memory_id: kept.id,
        merged_memory_ids: merged.map((memory) => memory.id),
        relinked_claims: relinkedClaims,
        suspected_claims: suspectedClaims,
        migrated_topics: migratedTopics
      }),
      ip: null,
      tenant_id: item.tenant_id
    });

    return {
      success: true,
      details: `Merged ${merged.length} memory record(s) into ${kept.id}`
    };
  }

  private executeConflictReview(
    item: ApprovalItem
  ): { success: boolean; error?: string; details?: string } {
    const claims = item.fact_claim_ids.map((id) => this.repository.getFactClaim(id));

    if (claims.some((claim) => claim === null)) {
      return {
        success: false,
        error: "Conflict review references fact claims that no longer exist"
      };
    }

    const memories = this.repository.getMemoriesByIds(item.memory_ids);

    if (memories.length !== item.memory_ids.length) {
      return {
        success: false,
        error: "Conflict review references memories that no longer exist"
      };
    }

    const resolvedAt = now();
    let resolvedClaims = 0;
    let verifiedMemories = 0;
    let archivedMemories = 0;

    this.repository.db.transaction(() => {
      for (const claim of claims) {
        if (claim === null || claim.status === "expired") {
          continue;
        }

        this.repository.updateFactClaimStatus(
          claim.id,
          "expired",
          "resolved_via_consolidation",
          resolvedAt,
          "user"
        );
        resolvedClaims += 1;
      }

      if (memories.length === 0) {
        return;
      }

      if (item.fact_claim_ids.length > 0) {
        for (const memory of memories) {
          if (memory.status !== "active" || memory.verified !== "conflict") {
            continue;
          }

          const remainingConflicts = this.repository
            .listFactClaimsBySourceMemoryId(memory.id)
            .filter(
              (claim) =>
                claim.status === "conflict" && !item.fact_claim_ids.includes(claim.id)
            );

          if (remainingConflicts.length === 0) {
            this.repository.updateMemory(memory.id, {
              verified: "verified",
              updated_at: resolvedAt
            });
            verifiedMemories += 1;
          }
        }

        return;
      }

      const sortedMemories = [...memories].sort(compareMemoryRecency).reverse();
      const kept = sortedMemories[0];

      for (const memory of sortedMemories) {
        if (memory.id === kept?.id) {
          if (memory.status === "active" && memory.verified === "conflict") {
            this.repository.updateMemory(memory.id, {
              verified: "verified",
              updated_at: resolvedAt
            });
            verifiedMemories += 1;
          }

          continue;
        }

        if (memory.status !== "active") {
          continue;
        }

        archivedMemories += this.archiveMemory(
          memory,
          resolvedAt,
          `Conflict memory ${memory.id} archived during approved consolidation review.`
        );
      }
    });

    this.repository.logAudit({
      timestamp: resolvedAt,
      actor: item.reviewed_by ?? "system",
      action: "consolidation_approval_executed",
      memory_id: item.memory_ids[0] ?? null,
      detail: JSON.stringify({
        approval_id: item.id,
        action: item.candidate_action,
        resolved_claims: resolvedClaims,
        verified_memories: verifiedMemories,
        archived_memories: archivedMemories
      }),
      ip: null,
      tenant_id: item.tenant_id
    });

    return {
      success: true,
      details: `Resolved ${resolvedClaims} claim(s), verified ${verifiedMemories} memory record(s), archived ${archivedMemories} memory record(s)`
    };
  }

  private executeMarkExpired(
    item: ApprovalItem
  ): { success: boolean; error?: string; details?: string } {
    const claims = item.fact_claim_ids.map((id) => this.repository.getFactClaim(id));

    if (claims.length === 0) {
      return {
        success: false,
        error: "mark_expired approval requires fact claims"
      };
    }

    if (claims.some((claim) => claim === null)) {
      return {
        success: false,
        error: "mark_expired approval references fact claims that no longer exist"
      };
    }

    const expiredAt = now();
    let updatedCount = 0;

    for (const claim of claims) {
      if (claim === null || claim.status === "expired") {
        continue;
      }

      this.repository.updateFactClaimStatus(
        claim.id,
        "expired",
        "approved_via_consolidation",
        expiredAt,
        "user"
      );
      updatedCount += 1;
    }

    this.repository.logAudit({
      timestamp: expiredAt,
      actor: item.reviewed_by ?? "system",
      action: "consolidation_approval_executed",
      memory_id: item.memory_ids[0] ?? null,
      detail: JSON.stringify({
        approval_id: item.id,
        action: item.candidate_action,
        expired_claims: updatedCount
      }),
      ip: null,
      tenant_id: item.tenant_id
    });

    return {
      success: true,
      details: `Marked ${updatedCount} fact claim(s) expired`
    };
  }

  private executeArchive(
    item: ApprovalItem
  ): { success: boolean; error?: string; details?: string } {
    const memories = this.repository.getMemoriesByIds(item.memory_ids);

    if (memories.length === 0) {
      return {
        success: false,
        error: "archive approval requires memories"
      };
    }

    if (memories.length !== item.memory_ids.length) {
      return {
        success: false,
        error: "archive approval references memories that no longer exist"
      };
    }

    const archivedAt = now();
    let archivedCount = 0;

    for (const memory of memories) {
      if (memory.status !== "active") {
        continue;
      }

      archivedCount += this.archiveMemory(
        memory,
        archivedAt,
        `Memory ${memory.id} archived during approved consolidation action.`
      );
    }

    this.repository.logAudit({
      timestamp: archivedAt,
      actor: item.reviewed_by ?? "system",
      action: "consolidation_approval_executed",
      memory_id: item.memory_ids[0] ?? null,
      detail: JSON.stringify({
        approval_id: item.id,
        action: item.candidate_action,
        archived_memories: archivedCount
      }),
      ip: null,
      tenant_id: item.tenant_id
    });

    return {
      success: true,
      details: `Archived ${archivedCount} memory record(s)`
    };
  }

  private archiveMemory(memory: Memory, archivedAt: string, reason: string): number {
    this.repository.updateMemory(memory.id, {
      status: "archived",
      updated_at: archivedAt
    });

    for (const claim of this.repository.listFactClaimsBySourceMemoryId(memory.id)) {
      if (claim.status !== "active") {
        continue;
      }

      this.repository.updateFactClaimStatus(claim.id, "suspected_expired", reason);
    }

    for (const assignment of this.repository.listMemoryTopicsByMemoryId(memory.id, "active")) {
      this.repository.updateMemoryTopic(memory.id, assignment.topic_id, {
        status: "superseded",
        updated_at: archivedAt
      });
    }

    return 1;
  }

  private requireApprovalItem(id: string): ApprovalItem {
    const item = this.repository.getApprovalItem(id);

    if (item === null) {
      throw new Error(`Approval item not found: ${id}`);
    }

    return item;
  }
}
