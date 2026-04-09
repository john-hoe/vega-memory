import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { ArchiveService } from "./archive-service.js";
import type { AuditContext, FactClaim, Memory, MemoryTopic } from "./types.js";

const now = (): string => new Date().toISOString();

const resolveAuditContext = (auditContext?: AuditContext): AuditContext => ({
  actor: auditContext?.actor ?? "system",
  ip: auditContext?.ip ?? null,
  tenant_id: auditContext?.tenant_id ?? null
});

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

const contentOverlaps = (left: string, right: string): boolean => {
  const normalizedLeft = left.trim();
  const normalizedRight = right.trim();

  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return false;
  }

  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
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

const uniqueClaimText = (claims: FactClaim[]): string =>
  [...new Set(claims.map((claim) => claim.claim_text.trim()).filter(Boolean))].join("\n");

export interface SidecarMutationResult {
  relinkedClaims: number;
  suspectedClaims: number;
  migratedTopics: number;
  supersededTopics: number;
  recoveredArchives: number;
  deletedTopicLinks: number;
}

export interface SidecarReconcileResult extends SidecarMutationResult {
  scannedMemories: number;
  scannedClaims: number;
  mergedMemories: number;
}

const emptyMutationResult = (): SidecarMutationResult => ({
  relinkedClaims: 0,
  suspectedClaims: 0,
  migratedTopics: 0,
  supersededTopics: 0,
  recoveredArchives: 0,
  deletedTopicLinks: 0
});

const emptyReconcileResult = (): SidecarReconcileResult => ({
  scannedMemories: 0,
  scannedClaims: 0,
  mergedMemories: 0,
  ...emptyMutationResult()
});

const mergeMutationResult = (
  target: SidecarMutationResult,
  source: SidecarMutationResult
): void => {
  target.relinkedClaims += source.relinkedClaims;
  target.suspectedClaims += source.suspectedClaims;
  target.migratedTopics += source.migratedTopics;
  target.supersededTopics += source.supersededTopics;
  target.recoveredArchives += source.recoveredArchives;
  target.deletedTopicLinks += source.deletedTopicLinks;
};

export class SidecarReconciler {
  private readonly archiveService: ArchiveService;

  constructor(
    private readonly repository: Repository,
    config?: VegaConfig,
    archiveService = new ArchiveService(repository, config)
  ) {
    this.archiveService = archiveService;
  }

  private logAudit(
    action: string,
    memoryId: string | null,
    detail: Record<string, unknown>,
    auditContext?: AuditContext,
    tenantId?: string | null
  ): void {
    const resolvedAuditContext = resolveAuditContext(auditContext);

    this.repository.logAudit({
      timestamp: now(),
      actor: resolvedAuditContext.actor,
      action,
      memory_id: memoryId,
      detail: JSON.stringify(detail),
      ip: resolvedAuditContext.ip,
      tenant_id: tenantId ?? resolvedAuditContext.tenant_id ?? null
    });
  }

  private ensureFallbackArchive(
    memoryId: string,
    memory: Memory | null,
    claims: FactClaim[]
  ): { archiveId: string | null; recoveredArchives: number } {
    const existingArchiveId = claims.find((claim) => claim.evidence_archive_id !== null)?.evidence_archive_id;

    if (existingArchiveId) {
      return {
        archiveId: existingArchiveId,
        recoveredArchives: 0
      };
    }

    const archivedSource = this.repository.listRawArchivesBySourceMemoryId(memoryId, 1)[0];
    if (archivedSource) {
      return {
        archiveId: archivedSource.id,
        recoveredArchives: 0
      };
    }

    if (memory !== null) {
      const archive = this.archiveService.store(memory.content, "document", memory.project, {
        tenant_id: memory.tenant_id ?? null,
        source_memory_id: memory.id,
        title: memory.title,
        metadata: {
          captured_from: "sidecar_reconciler",
          reason: "memory_delete"
        }
      });

      return {
        archiveId: archive.id,
        recoveredArchives: archive.created ? 1 : 0
      };
    }

    if (claims.length === 0) {
      return {
        archiveId: null,
        recoveredArchives: 0
      };
    }

    const archive = this.archiveService.store(uniqueClaimText(claims), "document", claims[0].project, {
      tenant_id: claims[0].tenant_id ?? null,
      source_memory_id: null,
      title: `Recovered evidence for ${memoryId}`,
      metadata: {
        captured_from: "sidecar_reconciler",
        reason: "claim_recovery",
        source_memory_id: memoryId,
        claim_ids: claims.map((claim) => claim.id)
      }
    });

    return {
      archiveId: archive.id,
      recoveredArchives: archive.created ? 1 : 0
    };
  }

  private supersedeActiveTopics(memoryId: string, timestamp: string): number {
    let supersededTopics = 0;

    for (const assignment of this.repository.listMemoryTopicsByMemoryId(memoryId, "active")) {
      this.repository.updateMemoryTopic(memoryId, assignment.topic_id, {
        status: "superseded",
        updated_at: timestamp
      });
      supersededTopics += 1;
    }

    return supersededTopics;
  }

  private updateClaimToSuspectedExpired(
    claim: FactClaim,
    reason: string
  ): boolean {
    if (claim.status !== "active") {
      return false;
    }

    this.repository.updateFactClaimStatus(claim.id, "suspected_expired", reason);
    return true;
  }

  private findMergeTarget(memory: Memory, activeMemories: Memory[]): Memory | null {
    const matches = activeMemories.filter(
      (candidate) =>
        candidate.id !== memory.id &&
        candidate.project === memory.project &&
        candidate.type === memory.type &&
        (candidate.tenant_id ?? null) === (memory.tenant_id ?? null) &&
        contentOverlaps(candidate.content, memory.content)
    );

    return matches.length === 1 ? matches[0] : null;
  }

  onMemoryMerged(
    keptId: string,
    mergedIds: string[],
    auditContext?: AuditContext
  ): SidecarMutationResult {
    const uniqueMergedIds = [...new Set(mergedIds.filter((id) => id !== keptId))];
    const keptMemory = this.repository.getMemory(keptId);
    const result = emptyMutationResult();

    if (keptMemory === null || uniqueMergedIds.length === 0) {
      return result;
    }

    const timestamp = now();
    const activeKeptClaims = new Set(
      this.repository
        .listFactClaimsBySourceMemoryId(keptId)
        .filter((claim) => claim.status === "active")
        .map(claimIdentity)
    );

    this.repository.db.transaction(() => {
      for (const mergedId of uniqueMergedIds) {
        for (const claim of this.repository.listFactClaimsBySourceMemoryId(mergedId)) {
          this.repository.updateFactClaimProvenance(claim.id, {
            source_memory_id: keptId,
            evidence_archive_id: claim.evidence_archive_id,
            source: resolveClaimSource(keptId, claim.evidence_archive_id, claim.source),
            updated_at: timestamp
          });
          result.relinkedClaims += 1;

          if (claim.status !== "active") {
            continue;
          }

          const identity = claimIdentity(claim);
          if (activeKeptClaims.has(identity)) {
            this.repository.updateFactClaimStatus(
              claim.id,
              "suspected_expired",
              `Duplicate claim consolidated during merge into memory ${keptId}.`
            );
            result.suspectedClaims += 1;
            continue;
          }

          activeKeptClaims.add(identity);
        }

        for (const assignment of this.repository.listMemoryTopicsByMemoryId(mergedId, "active")) {
          const existing = this.repository.getMemoryTopic(keptId, assignment.topic_id);

          if (existing) {
            this.repository.updateMemoryTopic(keptId, assignment.topic_id, {
              source: mergeTopicSource(existing.source, assignment.source),
              confidence: mergeTopicConfidence(existing, assignment),
              status: "active",
              updated_at: timestamp
            });
          } else {
            this.repository.createMemoryTopic({
              memory_id: keptId,
              topic_id: assignment.topic_id,
              source: assignment.source,
              confidence: assignment.confidence,
              status: "active",
              created_at: assignment.created_at,
              updated_at: timestamp
            });
          }

          this.repository.updateMemoryTopic(mergedId, assignment.topic_id, {
            status: "superseded",
            updated_at: timestamp
          });
          result.migratedTopics += 1;
          result.supersededTopics += 1;
        }
      }
    });

    this.logAudit(
      "sidecar_memory_merged",
      keptId,
      {
        kept_id: keptId,
        merged_ids: uniqueMergedIds,
        relinked_claims: result.relinkedClaims,
        suspected_claims: result.suspectedClaims,
        migrated_topics: result.migratedTopics,
        superseded_topics: result.supersededTopics
      },
      auditContext,
      keptMemory.tenant_id ?? null
    );

    return result;
  }

  onMemoryArchived(memoryId: string, auditContext?: AuditContext): SidecarMutationResult {
    const memory = this.repository.getMemory(memoryId);
    const claims = this.repository.listFactClaimsBySourceMemoryId(memoryId);
    const result = emptyMutationResult();
    const timestamp = now();

    this.repository.db.transaction(() => {
      for (const claim of claims) {
        if (
          this.updateClaimToSuspectedExpired(
            claim,
            `Source memory ${memoryId} was archived during sidecar reconciliation.`
          )
        ) {
          result.suspectedClaims += 1;
        }
      }

      result.supersededTopics += this.supersedeActiveTopics(memoryId, timestamp);
    });

    this.logAudit(
      "sidecar_memory_archived",
      memoryId,
      {
        memory_id: memoryId,
        suspected_claims: result.suspectedClaims,
        superseded_topics: result.supersededTopics
      },
      auditContext,
      memory?.tenant_id ?? claims[0]?.tenant_id ?? null
    );

    return result;
  }

  onMemoryDeleted(memoryId: string, auditContext?: AuditContext): SidecarMutationResult {
    const memory = this.repository.getMemory(memoryId);
    const claims = this.repository.listFactClaimsBySourceMemoryId(memoryId);
    const result = emptyMutationResult();
    const topicLinks = this.repository.listMemoryTopicsByMemoryId(memoryId).length;
    const { archiveId, recoveredArchives } = this.ensureFallbackArchive(memoryId, memory, claims);
    const timestamp = now();

    result.recoveredArchives = recoveredArchives;
    result.deletedTopicLinks = topicLinks;

    this.repository.db.transaction(() => {
      for (const claim of claims) {
        const evidenceArchiveId = claim.evidence_archive_id ?? archiveId;

        this.repository.updateFactClaimProvenance(claim.id, {
          source_memory_id: null,
          evidence_archive_id: evidenceArchiveId,
          source: resolveClaimSource(null, evidenceArchiveId, claim.source),
          updated_at: timestamp
        });
        result.relinkedClaims += 1;

        if (
          this.updateClaimToSuspectedExpired(
            claim,
            `Source memory ${memoryId} was deleted during sidecar reconciliation.`
          )
        ) {
          result.suspectedClaims += 1;
        }
      }
    });

    this.logAudit(
      "sidecar_memory_deleted",
      memoryId,
      {
        memory_id: memoryId,
        relinked_claims: result.relinkedClaims,
        suspected_claims: result.suspectedClaims,
        recovered_archives: result.recoveredArchives,
        deleted_topic_links: result.deletedTopicLinks,
        evidence_archive_id: archiveId
      },
      auditContext,
      memory?.tenant_id ?? claims[0]?.tenant_id ?? null
    );

    return result;
  }

  reconcileAll(project?: string, auditContext?: AuditContext): SidecarReconcileResult {
    const memories = this.repository.listMemories({
      project,
      limit: 100_000
    });
    const result = emptyReconcileResult();
    const activeMemories = memories.filter((memory) => memory.status === "active");

    result.scannedMemories = memories.length;

    for (const memory of memories) {
      if (memory.status !== "archived") {
        continue;
      }

      const hasSidecarData =
        this.repository.listFactClaimsBySourceMemoryId(memory.id).length > 0 ||
        this.repository.listMemoryTopicsByMemoryId(memory.id, "active").length > 0;
      const mergeTarget = hasSidecarData ? this.findMergeTarget(memory, activeMemories) : null;

      if (mergeTarget !== null) {
        mergeMutationResult(result, this.onMemoryMerged(mergeTarget.id, [memory.id], auditContext));
        result.mergedMemories += 1;
      }

      mergeMutationResult(result, this.onMemoryArchived(memory.id, auditContext));
    }

    const refreshedClaims = this.repository.listFactClaims(project);
    result.scannedClaims = refreshedClaims.length;
    const orphanedClaimsByMemoryId = new Map<string, FactClaim[]>();

    for (const claim of refreshedClaims) {
      if (claim.source_memory_id === null) {
        continue;
      }

      if (this.repository.getMemory(claim.source_memory_id) !== null) {
        continue;
      }

      const existing = orphanedClaimsByMemoryId.get(claim.source_memory_id);
      if (existing) {
        existing.push(claim);
        continue;
      }

      orphanedClaimsByMemoryId.set(claim.source_memory_id, [claim]);
    }

    for (const [memoryId, claims] of orphanedClaimsByMemoryId.entries()) {
      const { archiveId, recoveredArchives } = this.ensureFallbackArchive(memoryId, null, claims);
      const timestamp = now();

      result.recoveredArchives += recoveredArchives;

      this.repository.db.transaction(() => {
        for (const claim of claims) {
          const evidenceArchiveId = claim.evidence_archive_id ?? archiveId;

          this.repository.updateFactClaimProvenance(claim.id, {
            source_memory_id: null,
            evidence_archive_id: evidenceArchiveId,
            source: resolveClaimSource(null, evidenceArchiveId, claim.source),
            updated_at: timestamp
          });
          result.relinkedClaims += 1;

          if (
            this.updateClaimToSuspectedExpired(
              claim,
              `Source memory ${memoryId} was missing during full sidecar reconciliation.`
            )
          ) {
            result.suspectedClaims += 1;
          }
        }
      });
    }

    this.logAudit(
      "sidecar_reconcile_all",
      null,
      {
        project: project ?? null,
        scanned_memories: result.scannedMemories,
        scanned_claims: result.scannedClaims,
        merged_memories: result.mergedMemories,
        relinked_claims: result.relinkedClaims,
        suspected_claims: result.suspectedClaims,
        migrated_topics: result.migratedTopics,
        superseded_topics: result.supersededTopics,
        recovered_archives: result.recoveredArchives
      },
      auditContext
    );

    return result;
  }
}
