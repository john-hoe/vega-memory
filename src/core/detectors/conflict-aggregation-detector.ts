import type { ConsolidationDetector, DetectorContext } from "../consolidation-detector.js";
import type { ConsolidationCandidate, FactClaim, Memory, Topic } from "../types.js";

const MAX_MEMORY_SCAN = 10_000;

const normalizeTitle = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");

const conflictScore = (count: number): number => {
  if (count >= 5) {
    return 0.95;
  }

  if (count >= 3) {
    return 0.85;
  }

  return 0.7;
};

const buildClaimCandidate = (
  key: string,
  claims: FactClaim[]
): ConsolidationCandidate => {
  const [subject, predicate] = key.split("\u0000");
  const memoryIds = [
    ...new Set(
      claims
        .map((claim) => claim.source_memory_id)
        .filter((memoryId): memoryId is string => memoryId !== null)
    )
  ].sort();

  return {
    kind: "conflict_aggregation",
    action: "review_conflict",
    risk: "medium",
    memory_ids: memoryIds,
    fact_claim_ids: claims.map((claim) => claim.id),
    description: `Conflict group '${subject} ${predicate}': ${claims.length} claims need resolution`,
    evidence: claims.map(
      (claim) => `${claim.id}: ${claim.claim_value}${claim.valid_from ? ` @ ${claim.valid_from}` : ""}`
    ),
    score: conflictScore(claims.length)
  };
};

const buildMemoryCandidate = (
  label: string,
  memories: Memory[]
): ConsolidationCandidate => ({
  kind: "conflict_aggregation",
  action: "review_conflict",
  risk: "medium",
  memory_ids: memories.map((memory) => memory.id),
  fact_claim_ids: [],
  description: `Conflict memories on ${label}: ${memories.length} items`,
  evidence: memories.map((memory) => `${memory.id}: ${memory.title}`),
  score: conflictScore(memories.length)
});

const activeTopicKeyForMemory = (
  context: DetectorContext,
  memory: Memory,
  topicsById: Map<string, Topic>
): string | null => {
  const activeAssignments = context.repository.listMemoryTopicsByMemoryId(memory.id, "active");
  const activeTopicKeys = activeAssignments
    .map((assignment) => topicsById.get(assignment.topic_id)?.topic_key)
    .filter((topicKey): topicKey is string => topicKey !== undefined)
    .sort();

  return activeTopicKeys[0] ?? null;
};

const byCandidateOrder = (left: ConsolidationCandidate, right: ConsolidationCandidate): number => {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return left.description.localeCompare(right.description);
};

export class ConflictAggregationDetector implements ConsolidationDetector {
  readonly kind = "conflict_aggregation" as const;
  readonly label = "Conflict Aggregation";

  detect(context: DetectorContext): ConsolidationCandidate[] {
    const candidates: ConsolidationCandidate[] = [];
    const conflictClaims = context.repository.listFactClaims(
      context.project,
      "conflict",
      undefined,
      context.tenantId
    );
    const claimGroups = new Map<string, FactClaim[]>();

    for (const claim of conflictClaims) {
      const key = `${claim.subject}\u0000${claim.predicate}`;
      const group = claimGroups.get(key) ?? [];
      group.push(claim);
      claimGroups.set(key, group);
    }

    for (const [key, claims] of claimGroups.entries()) {
      if (claims.length < 2) {
        continue;
      }

      candidates.push(buildClaimCandidate(key, claims));
    }

    const topicsById = new Map(
      context.repository
        .listTopics(context.project, context.tenantId)
        .map((topic) => [topic.id, topic] as const)
    );
    const conflictMemories = context.repository.listMemories({
      project: context.project,
      tenant_id: context.tenantId ?? undefined,
      status: "active",
      verified: "conflict",
      limit: MAX_MEMORY_SCAN
    });
    const memoryGroups = new Map<string, { label: string; memories: Memory[] }>();

    for (const memory of conflictMemories) {
      const topicKey = activeTopicKeyForMemory(context, memory, topicsById);
      const key =
        topicKey !== null
          ? `topic:${topicKey}`
          : `title:${memory.type}\u0000${normalizeTitle(memory.title)}`;
      const label =
        topicKey !== null
          ? `topic '${topicKey}'`
          : `${memory.type} '${normalizeTitle(memory.title)}'`;
      const group = memoryGroups.get(key) ?? { label, memories: [] };
      group.memories.push(memory);
      memoryGroups.set(key, group);
    }

    for (const group of memoryGroups.values()) {
      if (group.memories.length < 2) {
        continue;
      }

      group.memories.sort((left, right) => left.id.localeCompare(right.id));
      candidates.push(buildMemoryCandidate(group.label, group.memories));
    }

    return candidates.sort(byCandidateOrder);
  }
}
