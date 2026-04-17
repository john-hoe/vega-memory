import { Repository } from "../../db/repository.js";
import type { SourceAdapter, SourceRecord, SourceSearchInput } from "./types.js";

const now = (): string => new Date().toISOString();

const toContent = (title: string, summary: string | null, content: string): string => {
  const sections = [title.trim()];

  if (summary !== null && summary.trim().length > 0) {
    sections.push(summary.trim());
  }

  sections.push(content.trim());
  return sections.filter((section) => section.length > 0).join("\n\n");
};

const hasQuery = (input: SourceSearchInput): boolean =>
  typeof input.request.query === "string" && input.request.query.trim().length > 0;

export function createPromotedMemorySource(repository: Repository): SourceAdapter {
  return {
    kind: "vega_memory",
    name: "promoted-memory",
    enabled: true,
    search(input) {
      if (!hasQuery(input)) {
        return [];
      }

      return repository
        .searchFTS(input.request.query!.trim(), input.request.project ?? undefined, undefined, true)
        .slice(0, input.top_k)
        .map(
          ({ memory, rank }): SourceRecord => ({
            id: memory.id,
            source_kind: "vega_memory",
            content: toContent(memory.title, memory.summary, memory.content),
            provenance: {
              origin: `memories:${memory.id}`,
              retrieved_at: now()
            },
            raw_score: rank,
            metadata: {
              memory_type: memory.type,
              project: memory.project,
              scope: memory.scope,
              verified: memory.verified,
              tags: memory.tags
            }
          })
        );
    }
  };
}
