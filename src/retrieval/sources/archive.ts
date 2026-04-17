import { ArchiveService } from "../../core/archive-service.js";
import type { SourceAdapter, SourceRecord, SourceSearchInput } from "./types.js";

const now = (): string => new Date().toISOString();

const hasQuery = (input: SourceSearchInput): boolean =>
  typeof input.request.query === "string" && input.request.query.trim().length > 0;

export function createArchiveSource(service: ArchiveService): SourceAdapter {
  return {
    kind: "archive",
    name: "archive",
    enabled: true,
    search(input) {
      if (!hasQuery(input)) {
        return [];
      }

      return service
        .search(input.request.query!.trim(), input.request.project ?? undefined, input.top_k)
        .map(
          ({ archive, rank }): SourceRecord => ({
            id: archive.id,
            source_kind: "archive",
            content: [archive.title.trim(), archive.content.trim()]
              .filter((section) => section.length > 0)
              .join("\n\n"),
            provenance: {
              origin: `archive:${archive.id}`,
              retrieved_at: now()
            },
            raw_score: rank,
            metadata: {
              archive_type: archive.archive_type,
              project: archive.project,
              source_memory_id: archive.source_memory_id,
              source_uri: archive.source_uri,
              captured_at: archive.captured_at,
              created_at: archive.created_at
            }
          })
        );
    }
  };
}
