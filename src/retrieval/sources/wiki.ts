import { Repository } from "../../db/repository.js";
import type { SourceAdapter, SourceRecord, SourceSearchInput } from "./types.js";

const now = (): string => new Date().toISOString();

const hasQuery = (input: SourceSearchInput): boolean =>
  typeof input.request.query === "string" && input.request.query.trim().length > 0;

interface WikiSearchRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  page_type: string;
  status: string;
  project: string | null;
  created_at: string;
  updated_at: string;
}

function mapWikiRow(page: WikiSearchRow): SourceRecord {
  return {
    id: page.id,
    source_kind: "wiki",
    content: [page.title.trim(), page.summary.trim()]
      .filter((section) => section.length > 0)
      .join("\n\n"),
    created_at: page.created_at,
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
  };
}

function listRecent(repository: Repository, input: SourceSearchInput): SourceRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (input.request.project) {
    clauses.push("project = ?");
    params.push(input.request.project);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = repository.db
    .prepare<unknown[], WikiSearchRow>(
      `SELECT
         id,
         slug,
         title,
         summary,
         page_type,
         status,
         project,
         created_at,
         updated_at
       FROM wiki_pages
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(...params, input.top_k);

  return rows.map(mapWikiRow);
}

function searchWithCreatedAt(repository: Repository, input: SourceSearchInput): SourceRecord[] {
  const clauses = ["wiki_pages_fts MATCH ?"];
  const params: unknown[] = [input.request.query!.trim()];

  if (input.request.project) {
    clauses.push("wiki_pages.project = ?");
    params.push(input.request.project);
  }

  const rows = repository.db
    .prepare<unknown[], WikiSearchRow>(
      `SELECT
         wiki_pages.id AS id,
         wiki_pages.slug AS slug,
         wiki_pages.title AS title,
         wiki_pages.summary AS summary,
         wiki_pages.page_type AS page_type,
         wiki_pages.status AS status,
         wiki_pages.project AS project,
         wiki_pages.created_at AS created_at,
         wiki_pages.updated_at AS updated_at
       FROM wiki_pages_fts
       JOIN wiki_pages ON wiki_pages.rowid = wiki_pages_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY bm25(wiki_pages_fts), wiki_pages.updated_at DESC
       LIMIT ?`
    )
    .all(...params, input.top_k);

  return rows.map(mapWikiRow);
}

export function createWikiSource(repository: Repository): SourceAdapter {
  return {
    kind: "wiki",
    name: "wiki",
    enabled: true,
    search(input) {
      const profile = input.request.intent;

      if (!hasQuery(input)) {
        if (profile === "bootstrap") {
          return listRecent(repository, input);
        }

        return [];
      }

      return searchWithCreatedAt(repository, input);
    }
  };
}
