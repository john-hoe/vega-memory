import type { VegaConfig } from "../config.js";
import { chatWithOllama } from "../embedding/ollama.js";
import type { ExtractionCandidate, MemoryType } from "./types.js";

const MEMORY_TYPES = new Set<MemoryType>([
  "task_state",
  "preference",
  "project_context",
  "decision",
  "pitfall",
  "insight"
]);

const stripMarkdownCodeFence = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
};

const extractJsonArray = (value: string): string => {
  const stripped = stripMarkdownCodeFence(value);
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");

  if (start === -1 || end === -1 || end < start) {
    return stripped;
  }

  return stripped.slice(start, end + 1);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeCandidate = (value: unknown): ExtractionCandidate | null => {
  if (!isRecord(value)) {
    return null;
  }

  const { type, title, content, tags } = value;
  if (
    typeof type !== "string" ||
    !MEMORY_TYPES.has(type as MemoryType) ||
    typeof title !== "string" ||
    typeof content !== "string" ||
    !Array.isArray(tags)
  ) {
    return null;
  }

  const normalizedTags = tags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  return {
    type: type as MemoryType,
    title: title.trim(),
    content: content.trim(),
    tags: [...new Set(normalizedTags)]
  };
};

export class ExtractionService {
  constructor(private readonly config: VegaConfig) {}

  async extractMemories(text: string, _project: string): Promise<ExtractionCandidate[]> {
    const response = await chatWithOllama(
      [
        {
          role: "system",
          content:
            "Analyze the following conversation/text and extract distinct pieces of knowledge worth remembering. For each, provide: type (decision/pitfall/preference/task_state/project_context), title (short), content (the knowledge), and tags (keywords). Output as JSON array. Only extract actionable, durable knowledge — skip emotions, one-time queries, and common knowledge."
        },
        {
          role: "user",
          content: text
        }
      ],
      this.config
    );

    if (response === null) {
      return [];
    }

    try {
      const parsed = JSON.parse(extractJsonArray(response)) as unknown;

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .map(normalizeCandidate)
        .filter(
          (candidate): candidate is ExtractionCandidate =>
            candidate !== null &&
            candidate.title.length > 0 &&
            candidate.content.length > 0
        );
    } catch {
      return [];
    }
  }
}
