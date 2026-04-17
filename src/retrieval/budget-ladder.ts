import type { RankedRecord } from "./ranker.js";

export const LADDER_LEVELS = ["full", "summary", "headline", "reference"] as const;

export type LadderLevel = (typeof LADDER_LEVELS)[number];

export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

function toSummary(content: string): string {
  if (content.length <= 200) {
    return content;
  }

  return `${content.slice(0, 200)}…`;
}

function toHeadline(content: string): string {
  const firstLine = content.split(/\r?\n/u, 1)[0]?.trim() ?? "";

  if (firstLine.length > 0) {
    return firstLine.slice(0, 60);
  }

  return content.slice(0, 60);
}

function toReference(record: RankedRecord): string {
  return `[${record.source_kind}:${record.id}]`;
}

export function ladderApply(
  record: RankedRecord,
  level: LadderLevel
): { content_used: string; estimated_tokens: number } {
  const content_used =
    level === "full"
      ? record.content
      : level === "summary"
        ? toSummary(record.content)
        : level === "headline"
          ? toHeadline(record.content)
          : toReference(record);

  return {
    content_used,
    estimated_tokens: estimateTokens(content_used)
  };
}
