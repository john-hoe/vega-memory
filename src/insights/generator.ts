import type { Memory } from "../core/types.js";
import { MemoryService } from "../core/memory.js";
import { Repository } from "../db/repository.js";
import type { InsightCandidate } from "./patterns.js";
import {
  detectDecisionPatterns,
  detectProjectRiskAreas,
  detectRepeatOffenders,
  detectTagClusters
} from "./patterns.js";

const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

const tokenize = (value: string): Set<string> =>
  new Set((normalize(value).match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 2));

const overlap = (left: string[], right: string[]): boolean => {
  const rightTags = new Set(right.map(normalize));
  return left.map(normalize).some((tag) => rightTags.has(tag));
};

const contentSimilarity = (left: string, right: string): number => {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

const getInsightFamily = (content: string): string => {
  if (content.startsWith("Tag '")) {
    return "tag_cluster";
  }
  if (content.startsWith("Recurring issue:")) {
    return "repeat_offender";
  }
  if (content.startsWith("Project '")) {
    return "project_risk";
  }
  if (content.startsWith("Decision pattern:")) {
    return "decision_pattern";
  }

  return "generic";
};

const isSimilarInsight = (candidate: InsightCandidate, memory: Memory): boolean => {
  if (candidate.project !== memory.project) {
    return false;
  }

  if (normalize(candidate.content) === normalize(memory.content)) {
    return true;
  }

  if (
    getInsightFamily(candidate.content) === getInsightFamily(memory.content) &&
    overlap(candidate.tags, memory.tags)
  ) {
    return true;
  }

  return contentSimilarity(candidate.content, memory.content) >= 0.75;
};

const compareCandidates = (left: InsightCandidate, right: InsightCandidate): number =>
  left.project.localeCompare(right.project) || left.content.localeCompare(right.content);

export class InsightGenerator {
  constructor(
    private readonly repository: Repository,
    private readonly memoryService: MemoryService
  ) {}

  async generateInsights(): Promise<number> {
    const candidates = [
      ...detectTagClusters(this.repository),
      ...detectRepeatOffenders(this.repository),
      ...detectProjectRiskAreas(this.repository),
      ...detectDecisionPatterns(this.repository)
    ].sort(compareCandidates);
    const knownInsights = this.repository.listMemories({
      type: "insight",
      status: "active",
      limit: 1_000_000,
      sort: "created_at ASC"
    });
    let created = 0;

    for (const candidate of candidates) {
      if (knownInsights.some((memory) => isSimilarInsight(candidate, memory))) {
        continue;
      }

      const result = await this.memoryService.store({
        content: candidate.content,
        type: "insight",
        project: candidate.project,
        tags: candidate.tags,
        source: "auto"
      });
      const stored = this.repository.getMemory(result.id);

      if (stored) {
        knownInsights.push(stored);
      }

      if (result.action === "created") {
        created += 1;
      }
    }

    return created;
  }
}
