import { v4 as uuidv4 } from "uuid";

import { Repository } from "../db/repository.js";
import type {
  ContentSource,
  ContentSourceType,
  PageWithBacklinks,
  WikiPage,
  WikiPageListFilters,
  WikiPageStatus,
  WikiPageType,
  WikiPageVersion
} from "./types.js";

interface WikiPageRow {
  id: string;
  slug: string;
  title: string;
  content: string;
  summary: string;
  page_type: WikiPageType;
  scope: WikiPage["scope"];
  project: string | null;
  tags: string;
  source_memory_ids: string;
  embedding: Buffer | null;
  status: WikiPageStatus;
  auto_generated: number;
  reviewed: number;
  version: number;
  space_id: string | null;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  published_at: string | null;
}

interface WikiPageVersionRow {
  id: string;
  page_id: string;
  content: string;
  summary: string;
  version: number;
  change_reason: string;
  created_at: string;
}

interface BacklinkRow {
  page_id: string;
  title: string;
  slug: string;
  context: string;
}

interface ContentSourceRow {
  id: string;
  source_type: ContentSourceType;
  url: string | null;
  title: string;
  raw_content: string;
  extracted_at: string;
  processed: number;
  project: string | null;
  tags: string;
}

interface PageRowId {
  rowid: number;
}

interface CreatePageParams {
  title: string;
  content: string;
  summary: string;
  page_type: WikiPageType;
  scope?: WikiPage["scope"];
  project?: string | null;
  tags?: string[];
  source_memory_ids?: string[];
  auto_generated?: boolean;
  space_id?: string | null;
  parent_id?: string | null;
  embedding?: Buffer | null;
}

interface CreateContentSourceParams {
  source_type: ContentSourceType;
  url?: string | null;
  title: string;
  raw_content: string;
  project?: string | null;
  tags?: string[];
}

interface ContentSourceListFilters {
  source_type?: ContentSourceType;
  processed?: boolean;
  limit?: number;
}

const PAGE_SORT_COLUMNS = new Set([
  "id",
  "slug",
  "title",
  "page_type",
  "scope",
  "project",
  "status",
  "version",
  "parent_id",
  "sort_order",
  "created_at",
  "updated_at",
  "reviewed_at",
  "published_at"
]);

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
}

function serializeJsonArray(value: string[]): string {
  return JSON.stringify(value);
}

function timestamp(): string {
  return new Date().toISOString();
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function normalizePageSort(sort?: string): string {
  if (!sort) {
    return "updated_at DESC";
  }

  const match = /^([a-z_]+)(?:\s+(ASC|DESC))?$/i.exec(sort.trim());
  if (!match) {
    throw new Error(`Unsupported sort: ${sort}`);
  }

  const [, column, direction = "ASC"] = match;
  if (!PAGE_SORT_COLUMNS.has(column)) {
    throw new Error(`Unsupported sort column: ${column}`);
  }

  return `${column} ${direction.toUpperCase()}`;
}

function normalizeSlugValue(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.length > 0 ? normalized : "page";
}

function mapWikiPage(row: WikiPageRow): WikiPage {
  return {
    ...row,
    tags: parseJsonArray(row.tags),
    source_memory_ids: parseJsonArray(row.source_memory_ids),
    auto_generated: row.auto_generated === 1,
    reviewed: row.reviewed === 1
  };
}

function mapWikiPageVersion(row: WikiPageVersionRow): WikiPageVersion {
  return row;
}

function mapContentSource(row: ContentSourceRow): ContentSource {
  return {
    ...row,
    processed: row.processed === 1,
    tags: parseJsonArray(row.tags)
  };
}

export class PageManager {
  constructor(readonly repository: Repository) {}

  private getPageById(id: string): WikiPage | null {
    const row = this.repository.db
      .prepare<[string], WikiPageRow>("SELECT * FROM wiki_pages WHERE id = ?")
      .get(id);

    return row ? mapWikiPage(row) : null;
  }

  private getPageBySlug(slug: string): WikiPage | null {
    const row = this.repository.db
      .prepare<[string], WikiPageRow>("SELECT * FROM wiki_pages WHERE slug = ?")
      .get(slug);

    return row ? mapWikiPage(row) : null;
  }

  private getPageRowId(id: string): number | null {
    const row = this.repository.db
      .prepare<[string], PageRowId>("SELECT rowid FROM wiki_pages WHERE id = ?")
      .get(id);

    return row?.rowid ?? null;
  }

  private slugExists(slug: string, excludeId?: string): boolean {
    if (excludeId) {
      const row = this.repository.db
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM wiki_pages WHERE slug = ? AND id != ?"
        )
        .get(slug, excludeId);

      return row !== undefined;
    }

    const row = this.repository.db
      .prepare<[string], { id: string }>("SELECT id FROM wiki_pages WHERE slug = ?")
      .get(slug);

    return row !== undefined;
  }

  private generateUniqueSlug(value: string, excludeId?: string): string {
    const baseSlug = normalizeSlugValue(value);
    let slug = baseSlug;
    let suffix = 2;

    while (this.slugExists(slug, excludeId)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    return slug;
  }

  generateSlug(title: string): string {
    return this.generateUniqueSlug(title);
  }

  createPage(params: CreatePageParams): WikiPage {
    const title = params.title.trim();
    if (title.length === 0) {
      throw new Error("Page title is required");
    }

    const createdAt = timestamp();
    const page: WikiPage = {
      id: uuidv4(),
      slug: this.generateSlug(title),
      title,
      content: params.content,
      summary: params.summary,
      page_type: params.page_type,
      scope: params.scope ?? "project",
      project: params.project ?? null,
      tags: params.tags ?? [],
      source_memory_ids: params.source_memory_ids ?? [],
      embedding: params.embedding ?? null,
      status: "draft",
      auto_generated: params.auto_generated ?? true,
      reviewed: false,
      version: 1,
      space_id: params.space_id ?? null,
      parent_id: params.parent_id ?? null,
      sort_order: 0,
      created_at: createdAt,
      updated_at: createdAt,
      reviewed_at: null,
      published_at: null
    };

    const insertPage = this.repository.db.prepare<
      [
        string,
        string,
        string,
        string,
        string,
        WikiPageType,
        WikiPage["scope"],
        string | null,
        string,
        string,
        Buffer | null,
        WikiPageStatus,
        number,
        number,
        number,
        string | null,
        string | null,
        number,
        string,
        string,
        string | null,
        string | null
      ]
    >(
      `INSERT INTO wiki_pages (
         id, slug, title, content, summary, page_type, scope, project, tags, source_memory_ids,
         embedding, status, auto_generated, reviewed, version, space_id, parent_id, sort_order,
         created_at, updated_at, reviewed_at, published_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFts = this.repository.db.prepare<[number, string, string, string, string]>(
      "INSERT INTO wiki_pages_fts (rowid, title, content, summary, tags) VALUES (?, ?, ?, ?, ?)"
    );

    this.repository.db.transaction(() => {
      const result = insertPage.run(
        page.id,
        page.slug,
        page.title,
        page.content,
        page.summary,
        page.page_type,
        page.scope,
        page.project,
        serializeJsonArray(page.tags),
        serializeJsonArray(page.source_memory_ids),
        page.embedding,
        page.status,
        page.auto_generated ? 1 : 0,
        page.reviewed ? 1 : 0,
        page.version,
        page.space_id,
        page.parent_id,
        page.sort_order,
        page.created_at,
        page.updated_at,
        page.reviewed_at,
        page.published_at
      );

      insertFts.run(
        Number(result.lastInsertRowid),
        page.title,
        page.content,
        page.summary,
        serializeJsonArray(page.tags)
      );
    })();

    return page;
  }

  getPage(idOrSlug: string): WikiPage | null {
    return this.getPageById(idOrSlug) ?? this.getPageBySlug(idOrSlug);
  }

  getPageWithBacklinks(idOrSlug: string): PageWithBacklinks | null {
    const page = this.getPage(idOrSlug);
    if (!page) {
      return null;
    }

    return {
      page,
      backlinks: this.getBacklinks(page.id)
    };
  }

  updatePage(id: string, updates: Partial<WikiPage>, changeReason: string): WikiPage {
    const existing = this.getPageById(id);
    if (!existing) {
      throw new Error(`Wiki page not found: ${id}`);
    }

    const rowId = this.getPageRowId(id);
    if (rowId === null) {
      throw new Error(`Wiki page rowid not found: ${id}`);
    }

    const updatedAt = timestamp();
    const nextTitle =
      updates.title === undefined ? existing.title : updates.title.trim();
    if (nextTitle.length === 0) {
      throw new Error("Page title is required");
    }

    const nextPage: WikiPage = {
      id: existing.id,
      slug:
        updates.slug === undefined
          ? existing.slug
          : this.generateUniqueSlug(updates.slug, existing.id),
      title: nextTitle,
      content: updates.content ?? existing.content,
      summary: updates.summary ?? existing.summary,
      page_type: updates.page_type ?? existing.page_type,
      scope: updates.scope ?? existing.scope,
      project: updates.project === undefined ? existing.project : updates.project,
      tags: updates.tags ?? existing.tags,
      source_memory_ids: updates.source_memory_ids ?? existing.source_memory_ids,
      embedding: updates.embedding === undefined ? existing.embedding : updates.embedding,
      status: updates.status ?? existing.status,
      auto_generated: updates.auto_generated ?? existing.auto_generated,
      reviewed: updates.reviewed ?? existing.reviewed,
      version: existing.version + 1,
      space_id: updates.space_id === undefined ? existing.space_id : updates.space_id,
      parent_id: updates.parent_id === undefined ? existing.parent_id : updates.parent_id,
      sort_order: updates.sort_order ?? existing.sort_order,
      created_at: existing.created_at,
      updated_at: updatedAt,
      reviewed_at: updates.reviewed_at === undefined ? existing.reviewed_at : updates.reviewed_at,
      published_at:
        updates.published_at === undefined ? existing.published_at : updates.published_at
    };

    const insertVersion = this.repository.db.prepare<
      [string, string, string, string, number, string, string]
    >(
      `INSERT INTO wiki_page_versions (
         id, page_id, content, summary, version, change_reason, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const updatePage = this.repository.db.prepare<
      [
        string,
        string,
        string,
        string,
        WikiPageType,
        WikiPage["scope"],
        string | null,
        string,
        string,
        Buffer | null,
        WikiPageStatus,
        number,
        number,
        number,
        string | null,
        string | null,
        number,
        string,
        string | null,
        string | null,
        string
      ]
    >(
      `UPDATE wiki_pages
       SET slug = ?,
           title = ?,
           content = ?,
           summary = ?,
           page_type = ?,
           scope = ?,
           project = ?,
           tags = ?,
           source_memory_ids = ?,
           embedding = ?,
           status = ?,
           auto_generated = ?,
           reviewed = ?,
           version = ?,
           space_id = ?,
           parent_id = ?,
           sort_order = ?,
           updated_at = ?,
           reviewed_at = ?,
           published_at = ?
       WHERE id = ?`
    );
    const deleteFts = this.repository.db.prepare<[number, string, string, string, string]>(
      `INSERT INTO wiki_pages_fts (wiki_pages_fts, rowid, title, content, summary, tags)
       VALUES ('delete', ?, ?, ?, ?, ?)`
    );
    const insertFts = this.repository.db.prepare<[number, string, string, string, string]>(
      "INSERT INTO wiki_pages_fts (rowid, title, content, summary, tags) VALUES (?, ?, ?, ?, ?)"
    );

    this.repository.db.transaction(() => {
      insertVersion.run(
        uuidv4(),
        existing.id,
        existing.content,
        existing.summary,
        existing.version,
        changeReason,
        updatedAt
      );

      updatePage.run(
        nextPage.slug,
        nextPage.title,
        nextPage.content,
        nextPage.summary,
        nextPage.page_type,
        nextPage.scope,
        nextPage.project,
        serializeJsonArray(nextPage.tags),
        serializeJsonArray(nextPage.source_memory_ids),
        nextPage.embedding,
        nextPage.status,
        nextPage.auto_generated ? 1 : 0,
        nextPage.reviewed ? 1 : 0,
        nextPage.version,
        nextPage.space_id,
        nextPage.parent_id,
        nextPage.sort_order,
        nextPage.updated_at,
        nextPage.reviewed_at,
        nextPage.published_at,
        nextPage.id
      );

      deleteFts.run(
        rowId,
        existing.title,
        existing.content,
        existing.summary,
        serializeJsonArray(existing.tags)
      );
      insertFts.run(
        rowId,
        nextPage.title,
        nextPage.content,
        nextPage.summary,
        serializeJsonArray(nextPage.tags)
      );
    })();

    return nextPage;
  }

  deletePage(id: string): void {
    const existing = this.getPageById(id);
    const rowId = this.getPageRowId(id);
    if (!existing || rowId === null) {
      return;
    }

    const deleteFts = this.repository.db.prepare<[number, string, string, string, string]>(
      `INSERT INTO wiki_pages_fts (wiki_pages_fts, rowid, title, content, summary, tags)
       VALUES ('delete', ?, ?, ?, ?, ?)`
    );
    const deletePage = this.repository.db.prepare<[string]>("DELETE FROM wiki_pages WHERE id = ?");

    this.repository.db.transaction(() => {
      deleteFts.run(
        rowId,
        existing.title,
        existing.content,
        existing.summary,
        serializeJsonArray(existing.tags)
      );
      deletePage.run(id);
    })();
  }

  listPages(filters: WikiPageListFilters): WikiPage[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.project) {
      clauses.push("project = ?");
      params.push(filters.project);
    }
    if (filters.page_type) {
      clauses.push("page_type = ?");
      params.push(filters.page_type);
    }
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters.parent_id !== undefined) {
      if (filters.parent_id === null) {
        clauses.push("parent_id IS NULL");
      } else {
        clauses.push("parent_id = ?");
        params.push(filters.parent_id);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const orderBy = normalizePageSort(filters.sort);
    const limit = normalizePositiveInteger(filters.limit, 100);
    const rows = this.repository.db
      .prepare<unknown[], WikiPageRow>(
        `SELECT * FROM wiki_pages ${where} ORDER BY ${orderBy} LIMIT ?`
      )
      .all(...params, limit);

    return rows.map(mapWikiPage);
  }

  getVersions(pageId: string): WikiPageVersion[] {
    return this.repository.db
      .prepare<[string], WikiPageVersionRow>(
        `SELECT id, page_id, content, summary, version, change_reason, created_at
         FROM wiki_page_versions
         WHERE page_id = ?
         ORDER BY version DESC`
      )
      .all(pageId)
      .map(mapWikiPageVersion);
  }

  addCrossReference(
    sourcePageId: string,
    targetPageId: string,
    context: string,
    autoGenerated = true
  ): void {
    this.repository.db
      .prepare<[string, string, string, string, number, string]>(
        `INSERT OR IGNORE INTO wiki_cross_references (
           id, source_page_id, target_page_id, context, auto_generated, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(uuidv4(), sourcePageId, targetPageId, context, autoGenerated ? 1 : 0, timestamp());
  }

  removeCrossReferences(pageId: string): void {
    this.repository.db
      .prepare<[string]>("DELETE FROM wiki_cross_references WHERE source_page_id = ?")
      .run(pageId);
  }

  getBacklinks(pageId: string): { page_id: string; title: string; slug: string; context: string }[] {
    return this.repository.db
      .prepare<[string], BacklinkRow>(
        `SELECT
           wiki_cross_references.source_page_id AS page_id,
           wiki_pages.title AS title,
           wiki_pages.slug AS slug,
           wiki_cross_references.context AS context
         FROM wiki_cross_references
         JOIN wiki_pages ON wiki_pages.id = wiki_cross_references.source_page_id
         WHERE wiki_cross_references.target_page_id = ?
         ORDER BY wiki_cross_references.created_at DESC`
      )
      .all(pageId);
  }

  createContentSource(params: CreateContentSourceParams): ContentSource {
    const title = params.title.trim();
    if (title.length === 0) {
      throw new Error("Content source title is required");
    }

    const contentSource: ContentSource = {
      id: uuidv4(),
      source_type: params.source_type,
      url: params.url ?? null,
      title,
      raw_content: params.raw_content,
      extracted_at: timestamp(),
      processed: false,
      project: params.project ?? null,
      tags: params.tags ?? []
    };

    this.repository.db
      .prepare<[string, ContentSourceType, string | null, string, string, string, number, string | null, string]>(
        `INSERT INTO content_sources (
           id, source_type, url, title, raw_content, extracted_at, processed, project, tags
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        contentSource.id,
        contentSource.source_type,
        contentSource.url,
        contentSource.title,
        contentSource.raw_content,
        contentSource.extracted_at,
        contentSource.processed ? 1 : 0,
        contentSource.project,
        serializeJsonArray(contentSource.tags)
      );

    return contentSource;
  }

  listContentSources(filters: ContentSourceListFilters): ContentSource[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.source_type) {
      clauses.push("source_type = ?");
      params.push(filters.source_type);
    }
    if (filters.processed !== undefined) {
      clauses.push("processed = ?");
      params.push(filters.processed ? 1 : 0);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = normalizePositiveInteger(filters.limit, 100);
    const rows = this.repository.db
      .prepare<unknown[], ContentSourceRow>(
        `SELECT *
         FROM content_sources
         ${where}
         ORDER BY extracted_at DESC
         LIMIT ?`
      )
      .all(...params, limit);

    return rows.map(mapContentSource);
  }

  markContentSourceProcessed(id: string): void {
    this.repository.db
      .prepare<[string]>("UPDATE content_sources SET processed = 1 WHERE id = ?")
      .run(id);
  }

  findStalePages(_memoryStalenessThreshold?: number, daysSinceReview = 30): WikiPage[] {
    const safeDaysSinceReview = normalizePositiveInteger(daysSinceReview, 30);
    const cutoff = new Date(Date.now() - safeDaysSinceReview * 24 * 60 * 60 * 1000).toISOString();

    return this.repository.db
      .prepare<[string], WikiPageRow>(
        `SELECT *
         FROM wiki_pages
         WHERE status = 'published'
           AND updated_at < ?
           AND auto_generated = 1
           AND reviewed = 0
         ORDER BY updated_at ASC`
      )
      .all(cutoff)
      .map(mapWikiPage);
  }
}
