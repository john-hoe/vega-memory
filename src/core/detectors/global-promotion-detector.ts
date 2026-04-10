import type { ConsolidationDetector, DetectorContext } from "../consolidation-detector.js";
import type { ConsolidationCandidate, Memory } from "../types.js";

const GLOBAL_PROMOTION_TYPES = new Set<Memory["type"]>([
  "pitfall",
  "insight",
  "decision",
  "preference"
]);

const promotionScore = (projectCount: number): number => {
  if (projectCount >= 4) {
    return 0.95;
  }

  if (projectCount >= 3) {
    return 0.8;
  }

  return 0.6;
};

export class GlobalPromotionDetector implements ConsolidationDetector {
  readonly kind = "global_promotion" as const;
  readonly label = "Global Promotion Candidates";

  detect(context: DetectorContext): ConsolidationCandidate[] {
    const memories = context.repository.listMemories({
      project: context.project,
      tenant_id: context.tenantId ?? undefined,
      status: "active",
      scope: "project",
      limit: 10_000
    });

    return memories
      .filter((memory) => GLOBAL_PROMOTION_TYPES.has(memory.type))
      .filter((memory) => new Set(memory.accessed_projects).size >= 2)
      .sort((left, right) => {
        const projectDelta =
          new Set(right.accessed_projects).size - new Set(left.accessed_projects).size;

        if (projectDelta !== 0) {
          return projectDelta;
        }

        return right.updated_at.localeCompare(left.updated_at);
      })
      .map((memory) => {
        const projects = [...new Set(memory.accessed_projects)].sort();

        return {
          kind: "global_promotion",
          action: "promote_global",
          risk: "low",
          memory_ids: [memory.id],
          fact_claim_ids: [],
          description: `'${memory.title}' accessed by ${projects.length} projects, consider promoting to global scope`,
          evidence: [
            `accessed_projects: ${projects.join(", ")}`,
            `type: ${memory.type}`,
            `current scope: ${memory.scope}`
          ],
          score: promotionScore(projects.length)
        } satisfies ConsolidationCandidate;
      });
  }
}
