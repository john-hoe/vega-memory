import { Repository } from "../db/repository.js";
import type { WikiPageStatus, WikiPageType } from "./types.js";

interface WikiSearchRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  page_type: WikiPageType;
  status: WikiPageStatus;
  project: string | null;
  updated_at: string;
  rank: number;
}

export interface WikiSearchFilters {
  query: string;
  project?: string;
  page_type?: WikiPageType;
  limit?: number;
}

export interface WikiSearchResult {
  id: string;
  slug: string;
  title: string;
  summary: string;
  page_type: WikiPageType;
  status: WikiPageStatus;
  project: string | null;
  updated_at: string;
}

const normalizePositiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;

export function searchWikiPages(
  repository: Repository,
  filters: WikiSearchFilters
): WikiSearchResult[] {
  const clauses = ["wiki_pages_fts MATCH ?"];
  const params: unknown[] = [filters.query];

  if (filters.project) {
    clauses.push("wiki_pages.project = ?");
    params.push(filters.project);
  }

  if (filters.page_type) {
    clauses.push("wiki_pages.page_type = ?");
    params.push(filters.page_type);
  }

  const limit = normalizePositiveInteger(filters.limit, 10);
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
         wiki_pages.updated_at AS updated_at,
         bm25(wiki_pages_fts) AS rank
       FROM wiki_pages_fts
       JOIN wiki_pages ON wiki_pages.rowid = wiki_pages_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY rank, wiki_pages.updated_at DESC
       LIMIT ?`
    )
    .all(...params, limit);

  return rows.map(({ rank: _rank, ...row }) => row);
}
