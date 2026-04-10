import type { ConsolidationDetector, DetectorContext } from "../consolidation-detector.js";
import type { ConsolidationCandidate, FactClaim, Memory } from "../types.js";

const byLatestValidFrom = (left: FactClaim, right: FactClaim): number => {
  const leftTimestamp = Date.parse(left.valid_from);
  const rightTimestamp = Date.parse(right.valid_from);

  if (leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }

  const leftUpdatedAt = Date.parse(left.updated_at);
  const rightUpdatedAt = Date.parse(right.updated_at);

  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }

  return right.id.localeCompare(left.id);
};

const byClaimOrder = (left: ConsolidationCandidate, right: ConsolidationCandidate): number => {
  const leftId = left.fact_claim_ids[0] ?? "";
  const rightId = right.fact_claim_ids[0] ?? "";

  return leftId.localeCompare(rightId);
};

const candidateMemoryIds = (claim: FactClaim): string[] =>
  claim.source_memory_id === null ? [] : [claim.source_memory_id];

const slotKey = (claim: Pick<FactClaim, "subject" | "predicate">): string =>
  `${claim.subject}\u0000${claim.predicate}`;

export class ExpiredFactDetector implements ConsolidationDetector {
  readonly kind = "expired_fact" as const;
  readonly label = "Suspected Expired Facts";

  detect(context: DetectorContext): ConsolidationCandidate[] {
    const claims = context.repository.listFactClaims(
      context.project,
      "active",
      undefined,
      context.tenantId
    );
    const sourceMemoryIds = [
      ...new Set(
        claims
          .map((claim) => claim.source_memory_id)
          .filter((memoryId): memoryId is string => memoryId !== null)
      )
    ];
    const sourceMemories = new Map<string, Memory>(
      context.repository
        .getMemoriesByIds(sourceMemoryIds)
        .map((memory) => [memory.id, memory])
    );
    const latestClaimsBySlot = new Map<string, FactClaim>();

    for (const claim of [...claims].sort(byLatestValidFrom)) {
      const key = slotKey(claim);

      if (!latestClaimsBySlot.has(key)) {
        latestClaimsBySlot.set(key, claim);
      }
    }

    const now = new Date().toISOString();
    const candidates: ConsolidationCandidate[] = [];

    for (const claim of claims) {
      if (claim.valid_to !== null && claim.valid_to < now) {
        candidates.push({
          kind: "expired_fact",
          action: "mark_expired",
          risk: "low",
          memory_ids: candidateMemoryIds(claim),
          fact_claim_ids: [claim.id],
          description: `Fact '${claim.subject} ${claim.predicate}' expired on ${claim.valid_to}`,
          evidence: [
            `valid_to: ${claim.valid_to}`,
            `current time: ${now}`,
            `claim value: ${claim.claim_value}`
          ],
          score: 1
        });
        continue;
      }

      const latestClaim = latestClaimsBySlot.get(slotKey(claim));

      if (
        latestClaim !== undefined &&
        latestClaim.id !== claim.id &&
        latestClaim.valid_from > claim.valid_from
      ) {
        candidates.push({
          kind: "expired_fact",
          action: "mark_expired",
          risk: "medium",
          memory_ids: candidateMemoryIds(claim),
          fact_claim_ids: [claim.id, latestClaim.id],
          description: `Fact '${claim.subject} ${claim.predicate}' was superseded by a newer claim from ${latestClaim.valid_from}`,
          evidence: [
            `older valid_from: ${claim.valid_from}`,
            `newer valid_from: ${latestClaim.valid_from}`,
            `newer claim value: ${latestClaim.claim_value}`
          ],
          score: 0.8
        });
        continue;
      }

      const sourceMemory = claim.source_memory_id
        ? sourceMemories.get(claim.source_memory_id)
        : undefined;

      if (sourceMemory?.verified === "conflict") {
        candidates.push({
          kind: "expired_fact",
          action: "review_conflict",
          risk: "high",
          memory_ids: [sourceMemory.id],
          fact_claim_ids: [claim.id],
          description: `Fact '${claim.subject} ${claim.predicate}' should be reviewed because its source memory is marked conflict`,
          evidence: [
            `source memory: ${sourceMemory.id}`,
            `source memory verified: ${sourceMemory.verified}`,
            `claim value: ${claim.claim_value}`
          ],
          score: 0.6
        });
      }
    }

    return candidates.sort(byClaimOrder);
  }
}
