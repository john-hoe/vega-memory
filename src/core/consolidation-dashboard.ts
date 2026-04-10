import { isFactClaimsEnabled, type VegaConfig } from "../config.js";
import type { Repository } from "../db/repository.js";
import { ConsolidationApprovalService } from "./consolidation-approval.js";
import { ConsolidationAuditService } from "./consolidation-audit.js";
import { DuplicateDetector } from "./detectors/duplicate-detector.js";
import { ExpiredFactDetector } from "./detectors/expired-fact-detector.js";
import { GlobalPromotionDetector } from "./detectors/global-promotion-detector.js";
import type {
  ConsolidationDashboardMetrics,
  FactClaim,
  Memory,
  MemoryType,
  Topic
} from "./types.js";

const MAX_MEMORY_SCAN = 10_000;

const roundRatio = (value: number): number => Number(value.toFixed(3));

const groupActiveTopicMemories = (
  repository: Repository,
  project: string,
  topics: Topic[]
): number[] =>
  topics.map((topic) => {
    const assignments = repository.listMemoryTopicsByTopicId(topic.id, "active");
    const memoryIds = [...new Set(assignments.map((assignment) => assignment.memory_id))];

    return repository
      .getMemoriesByIds(memoryIds)
      .filter((memory) => memory.status === "active" && memory.project === project).length;
  });

const countByType = (memories: Memory[]): Partial<Record<MemoryType, number>> =>
  memories.reduce<Partial<Record<MemoryType, number>>>((counts, memory) => {
    counts[memory.type] = (counts[memory.type] ?? 0) + 1;
    return counts;
  }, {});

const countClaimsByStatus = (claims: FactClaim[], status: FactClaim["status"]): number =>
  claims.filter((claim) => claim.status === status).length;

export class ConsolidationDashboardService {
  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {}

  generateDashboard(
    project: string,
    tenantId?: string | null
  ): ConsolidationDashboardMetrics {
    const activeMemories = this.repository.listMemories({
      project,
      tenant_id: tenantId ?? undefined,
      status: "active",
      limit: MAX_MEMORY_SCAN
    });
    const archivedMemories = this.repository.listMemories({
      project,
      tenant_id: tenantId ?? undefined,
      status: "archived",
      limit: MAX_MEMORY_SCAN
    });
    const conflictMemories = activeMemories.filter((memory) => memory.verified === "conflict");
    const factClaimsEnabled = isFactClaimsEnabled(this.config);
    const allClaims = factClaimsEnabled
      ? this.repository.listFactClaims(project, undefined, undefined, tenantId)
      : [];
    const activeClaims = factClaimsEnabled
      ? this.repository.listFactClaims(project, "active", undefined, tenantId)
      : [];
    const activeTopics = this.repository.listTopics(project, tenantId);
    const topicMemoryCounts = groupActiveTopicMemories(this.repository, project, activeTopics);

    const duplicateCandidates = new DuplicateDetector().detect({
      project,
      tenantId,
      repository: this.repository
    });
    const expiredCandidates = factClaimsEnabled
      ? new ExpiredFactDetector()
          .detect({
            project,
            tenantId,
            repository: this.repository
          })
          .filter((candidate) => candidate.action === "mark_expired")
      : [];
    const promotionCandidates = new GlobalPromotionDetector().detect({
      project,
      tenantId,
      repository: this.repository
    });
    const approvalService = new ConsolidationApprovalService(this.repository);
    const auditService = new ConsolidationAuditService(this.repository);
    const runs = auditService.listRuns(project, 10_000, tenantId);
    const lastRun = auditService.getLastRun(project, tenantId);
    const approvedApprovalCount = this.repository.countApprovalItemsByStatus(
      project,
      "approved",
      tenantId
    );
    const rejectedApprovalCount = this.repository.countApprovalItemsByStatus(
      project,
      "rejected",
      tenantId
    );

    return {
      project,
      generated_at: new Date().toISOString(),
      memory_stats: {
        total_active: activeMemories.length,
        total_archived: archivedMemories.length,
        by_type: countByType(activeMemories),
        by_scope: {
          project: activeMemories.filter((memory) => memory.scope === "project").length,
          global: activeMemories.filter((memory) => memory.scope === "global").length
        },
        conflict_count: conflictMemories.length
      },
      fact_claim_stats: {
        total_active: activeClaims.length,
        expired: countClaimsByStatus(allClaims, "expired"),
        suspected_expired: countClaimsByStatus(allClaims, "suspected_expired"),
        conflict: countClaimsByStatus(allClaims, "conflict")
      },
      topic_stats: {
        total_topics: activeTopics.length,
        topics_with_memories: topicMemoryCounts.filter((count) => count > 0).length,
        avg_memories_per_topic:
          activeTopics.length === 0
            ? 0
            : roundRatio(
                topicMemoryCounts.reduce((sum, count) => sum + count, 0) / activeTopics.length
              )
      },
      consolidation_history: {
        last_report_at: lastRun?.completed_at ?? null,
        total_reports_generated: runs.length,
        total_candidates_found: runs.reduce((sum, run) => sum + run.total_candidates, 0),
        total_candidates_resolved:
          runs.reduce((sum, run) => sum + run.actions_executed, 0) +
          this.countExecutedApprovals(project, tenantId)
      },
      // Future enhancements require historical session/cross-run aggregation that is not stored yet:
      // session_start(light) token trend, deep_recall trigger rate, wiki synthesis hit rate,
      // and auto-execution error count.
      approval_stats: {
        pending: approvalService.getPendingCount(project, tenantId),
        approved_total: approvedApprovalCount,
        rejected_total: rejectedApprovalCount
      },
      approved_pending_action: approvedApprovalCount - this.countExecutedApprovals(project, tenantId),
      health_indicators: {
        duplicate_density:
          activeMemories.length === 0
            ? 0
            : roundRatio(duplicateCandidates.length / activeMemories.length),
        stale_fact_ratio:
          activeClaims.length === 0 ? 0 : roundRatio(expiredCandidates.length / activeClaims.length),
        conflict_backlog: conflictMemories.length + countClaimsByStatus(allClaims, "conflict"),
        global_promotion_pending: promotionCandidates.length
      }
    };
  }

  private countExecutedApprovals(project: string, tenantId?: string | null): number {
    return this.repository.countExecutedApprovalItems(project, tenantId);
  }
}
