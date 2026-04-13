import type { Memory, MemoryType } from "../core/types.js";
import { Repository } from "../db/repository.js";

export interface InsightCandidate {
  content: string;
  tags: string[];
  project: string;
}

type HistoricalInsightPattern =
  | { family: "tag_cluster"; token: string; count: number }
  | { family: "repeat_offender"; token: string; count: number }
  | { family: "project_risk"; project: string; count: number }
  | { family: "decision_pattern"; token: string; count: number }
  | { family: "generic" };

interface SessionRow {
  id: string;
  project: string;
  memories_created: string;
}

const STOP_WORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "will",
  "into",
  "about",
  "there",
  "their",
  "would",
  "could",
  "should",
  "task",
  "project",
  "memory",
  "decision",
  "decisions"
]);

const LOW_SIGNAL_TAGS = new Set([
  "added",
  "implemented",
  "phase",
  "pending",
  "test",
  "tests",
  "testing",
  "fix",
  "fixed",
  "issue",
  "issues",
  "review",
  "reviewed",
  "verification",
  "verified",
  "update",
  "updated"
]);

const MIN_TAG_CLUSTER_COUNT = 4;
const MIN_REPEAT_OFFENDER_SESSION_COUNT = 4;
const MIN_PROJECT_RISK_PITFALL_COUNT = 6;
const MIN_DECISION_PATTERN_COUNT = 4;

const unique = (values: string[]): string[] => [...new Set(values)];

const normalize = (value: string): string => value.trim().toLowerCase();

const isHighSignalToken = (value: string): boolean =>
  value.length > 0 && !STOP_WORDS.has(value) && !LOW_SIGNAL_TAGS.has(value);

const parsePositiveInteger = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseHistoricalInsight = (content: string): HistoricalInsightPattern => {
  const tagClusterMatch = /^Tag '([^']+)': (\d+) pitfalls recorded\./.exec(content);
  if (tagClusterMatch) {
    return {
      family: "tag_cluster",
      token: normalize(tagClusterMatch[1] ?? ""),
      count: parsePositiveInteger(tagClusterMatch[2]) ?? 0
    };
  }

  const repeatOffenderMatch = /^Recurring issue: '([^']+)' appears across (\d+) sessions\./.exec(content);
  if (repeatOffenderMatch) {
    return {
      family: "repeat_offender",
      token: normalize(repeatOffenderMatch[1] ?? ""),
      count: parsePositiveInteger(repeatOffenderMatch[2]) ?? 0
    };
  }

  const projectRiskMatch = /^Project '([^']+)' has (\d+) pitfalls/.exec(content);
  if (projectRiskMatch) {
    return {
      family: "project_risk",
      project: projectRiskMatch[1] ?? "",
      count: parsePositiveInteger(projectRiskMatch[2]) ?? 0
    };
  }

  const decisionPatternMatch = /^Decision pattern: '([^']+)' influenced (\d+) decisions\./.exec(content);
  if (decisionPatternMatch) {
    return {
      family: "decision_pattern",
      token: normalize(decisionPatternMatch[1] ?? ""),
      count: parsePositiveInteger(decisionPatternMatch[2]) ?? 0
    };
  }

  return { family: "generic" };
};

const compareCandidates = (left: InsightCandidate, right: InsightCandidate): number =>
  left.project.localeCompare(right.project) || left.content.localeCompare(right.content);

const parseJsonArray = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
};

const listActiveMemories = (repository: Repository, type: MemoryType): Memory[] =>
  repository.listMemories({
    type,
    status: "active",
    limit: 1_000_000,
    sort: "created_at ASC"
  });

const getNormalizedTags = (memory: Memory): string[] =>
  unique(memory.tags.map(normalize).filter(isHighSignalToken));

const getDecisionKeywords = (memory: Memory): string[] => {
  if (memory.tags.length > 0) {
    return getNormalizedTags(memory);
  }

  return unique(
    (memory.content.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
      (token) => token.length > 3 && isHighSignalToken(token)
    )
  );
};

export function detectTagClusters(repository: Repository): InsightCandidate[] {
  const counts = new Map<string, number>();

  for (const pitfall of listActiveMemories(repository, "pitfall")) {
    for (const tag of getNormalizedTags(pitfall)) {
      const key = `${pitfall.project}\u0000${tag}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_TAG_CLUSTER_COUNT)
    .map(([key, count]) => {
      const [project, tag] = key.split("\u0000");
      return {
        content: `Tag '${tag}': ${count} pitfalls recorded. Common issue area.`,
        tags: [tag],
        project
      };
    })
    .sort(compareCandidates);
}

export function detectRepeatOffenders(repository: Repository): InsightCandidate[] {
  const pitfalls = listActiveMemories(repository, "pitfall");
  const pitfallsById = new Map(pitfalls.map((memory) => [memory.id, memory]));
  const sessions = repository.db
    .prepare<[], SessionRow>("SELECT id, project, memories_created FROM sessions")
    .all();
  const sessionCounts = new Map<string, Set<string>>();

  for (const session of sessions) {
    const tagsInSession = new Set<string>();

    for (const memoryId of parseJsonArray(session.memories_created)) {
      const pitfall = pitfallsById.get(memoryId);
      if (!pitfall || pitfall.project !== session.project) {
        continue;
      }

      for (const tag of getNormalizedTags(pitfall)) {
        tagsInSession.add(tag);
      }
    }

    for (const tag of tagsInSession) {
      const key = `${session.project}\u0000${tag}`;
      const sessionIds = sessionCounts.get(key) ?? new Set<string>();
      sessionIds.add(session.id);
      sessionCounts.set(key, sessionIds);
    }
  }

  return [...sessionCounts.entries()]
    .filter(([, sessionIds]) => sessionIds.size >= MIN_REPEAT_OFFENDER_SESSION_COUNT)
    .map(([key, sessionIds]) => {
      const [project, tag] = key.split("\u0000");
      return {
        content: `Recurring issue: '${tag}' appears across ${sessionIds.size} sessions.`,
        tags: [tag],
        project
      };
    })
    .sort(compareCandidates);
}

export function detectProjectRiskAreas(repository: Repository): InsightCandidate[] {
  const projectCounts = new Map<string, { count: number; tags: Set<string> }>();

  for (const pitfall of listActiveMemories(repository, "pitfall")) {
    const entry = projectCounts.get(pitfall.project) ?? {
      count: 0,
      tags: new Set<string>()
    };
    entry.count += 1;

    for (const tag of getNormalizedTags(pitfall)) {
      entry.tags.add(tag);
    }

    projectCounts.set(pitfall.project, entry);
  }

  return [...projectCounts.entries()]
    .filter(([, entry]) => entry.count >= MIN_PROJECT_RISK_PITFALL_COUNT)
    .map(([project, entry]) => ({
      content: `Project '${project}' has ${entry.count} pitfalls — higher risk area.`,
      tags: [...entry.tags].sort(),
      project
    }))
    .sort(compareCandidates);
}

export function detectDecisionPatterns(repository: Repository): InsightCandidate[] {
  const counts = new Map<string, number>();

  for (const decision of listActiveMemories(repository, "decision")) {
    for (const keyword of getDecisionKeywords(decision)) {
      const key = `${decision.project}\u0000${keyword}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_DECISION_PATTERN_COUNT)
    .map(([key, count]) => {
      const [project, tag] = key.split("\u0000");
      return {
        content: `Decision pattern: '${tag}' influenced ${count} decisions.`,
        tags: [tag],
        project
      };
    })
    .sort(compareCandidates);
}

export function shouldArchiveHistoricalInsight(memory: Memory): boolean {
  if (memory.type !== "insight" || memory.status !== "active" || memory.source !== "auto") {
    return false;
  }

  const parsed = parseHistoricalInsight(memory.content);

  switch (parsed.family) {
    case "tag_cluster":
      return !isHighSignalToken(parsed.token) || parsed.count < MIN_TAG_CLUSTER_COUNT;
    case "repeat_offender":
      return !isHighSignalToken(parsed.token) || parsed.count < MIN_REPEAT_OFFENDER_SESSION_COUNT;
    case "project_risk":
      return parsed.count < MIN_PROJECT_RISK_PITFALL_COUNT;
    case "decision_pattern":
      return !isHighSignalToken(parsed.token) || parsed.count < MIN_DECISION_PATTERN_COUNT;
    case "generic":
      return false;
  }
}
