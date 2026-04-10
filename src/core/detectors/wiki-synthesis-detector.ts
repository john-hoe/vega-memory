import { PageManager } from "../../wiki/page-manager.js";
import type { WikiPage } from "../../wiki/types.js";
import type { ConsolidationDetector, DetectorContext } from "../consolidation-detector.js";
import type { ConsolidationCandidate, Memory, Topic } from "../types.js";

const MAX_PAGE_SCAN = 1_000;

const normalizeTopicKey = (value: string): string => value.trim().toLowerCase();

const normalizeSlug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const activeMemoriesForTopic = (
  context: DetectorContext,
  topic: Topic
): Memory[] => {
  const assignments = context.repository.listMemoryTopicsByTopicId(topic.id, "active");
  const memoryIds = [...new Set(assignments.map((assignment) => assignment.memory_id))];

  return context.repository
    .getMemoriesByIds(memoryIds)
    .filter(
      (memory) =>
        memory.status === "active" &&
        memory.project === context.project &&
        (context.tenantId === undefined ||
          context.tenantId === null ||
          memory.tenant_id === context.tenantId)
    );
};

const hasExistingWikiPage = (
  pages: WikiPage[],
  topic: Topic,
  memories: Memory[]
): boolean => {
  const topicKey = normalizeTopicKey(topic.topic_key);
  const topicSlug = normalizeSlug(topic.topic_key);
  const memoryIds = new Set(memories.map((memory) => memory.id));

  return pages.some((page) => {
    if (page.status === "archived") {
      return false;
    }

    if (normalizeSlug(page.slug) === topicSlug) {
      return true;
    }

    if (page.tags.some((tag) => normalizeTopicKey(tag) === topicKey)) {
      return true;
    }

    return page.source_memory_ids.some((memoryId) => memoryIds.has(memoryId));
  });
};

const byTopicOrder = (left: ConsolidationCandidate, right: ConsolidationCandidate): number => {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return left.description.localeCompare(right.description);
};

export class WikiSynthesisDetector implements ConsolidationDetector {
  readonly kind = "wiki_synthesis" as const;
  readonly label = "Wiki Synthesis Candidates";

  detect(context: DetectorContext): ConsolidationCandidate[] {
    const pageManager = new PageManager(context.repository);
    const pages = pageManager.listPages({
      project: context.project,
      tenant_id: context.tenantId ?? undefined,
      limit: MAX_PAGE_SCAN,
      sort: "updated_at DESC"
    });

    return context.repository
      .listTopics(context.project, context.tenantId)
      .map((topic) => {
        const memories = activeMemoriesForTopic(context, topic);

        return {
          topic,
          memories
        };
      })
      .filter(({ memories }) => memories.length >= 3)
      .filter(({ topic, memories }) => !hasExistingWikiPage(pages, topic, memories))
      .map(({ topic, memories }) => {
        const memoryTypes = [...new Set(memories.map((memory) => memory.type))].sort();
        const memoryCount = memories.length;

        return {
          kind: "wiki_synthesis",
          action: "synthesize_wiki",
          risk: "low",
          memory_ids: memories.map((memory) => memory.id),
          fact_claim_ids: [],
          description: `Topic '${topic.topic_key}' has ${memoryCount} memories, suitable for wiki synthesis`,
          evidence: [
            `topic: ${topic.topic_key}`,
            `memory_count: ${memoryCount}`,
            `types: ${memoryTypes.join(", ")}`
          ],
          score: Number(Math.min(1, memoryCount / 10).toFixed(3))
        } satisfies ConsolidationCandidate;
      })
      .sort(byTopicOrder);
  }
}
