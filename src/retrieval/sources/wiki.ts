import { Repository } from "../../db/repository.js";
import { searchWikiPages } from "../../wiki/search.js";
import type { SourceAdapter, SourceRecord, SourceSearchInput } from "./types.js";

const now = (): string => new Date().toISOString();

const hasQuery = (input: SourceSearchInput): boolean =>
  typeof input.request.query === "string" && input.request.query.trim().length > 0;

export function createWikiSource(repository: Repository): SourceAdapter {
  return {
    kind: "wiki",
    name: "wiki",
    enabled: true,
    search(input) {
      if (!hasQuery(input)) {
        return [];
      }

      return searchWikiPages(repository, {
        query: input.request.query!.trim(),
        project: input.request.project ?? undefined,
        limit: input.top_k
      }).map(
        (page): SourceRecord => ({
          id: page.id,
          source_kind: "wiki",
          content: [page.title.trim(), page.summary.trim()]
            .filter((section) => section.length > 0)
            .join("\n\n"),
          provenance: {
            origin: `wiki:${page.id}`,
            retrieved_at: now()
          },
          metadata: {
            slug: page.slug,
            page_type: page.page_type,
            status: page.status,
            project: page.project,
            updated_at: page.updated_at
          }
        })
      );
    }
  };
}
