import assert from "node:assert/strict";
import test from "node:test";

import { Repository } from "../db/repository.js";
import { PageManager } from "../wiki/page-manager.js";

const createRepository = (): Repository => new Repository(":memory:");

test("createPage generates slug and returns wiki page with correct fields", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);

  try {
    const page = pageManager.createPage({
      title: "SQLite Setup Guide",
      content: "Install better-sqlite3-multiple-ciphers and enable WAL mode.",
      summary: "Setup guide for SQLite.",
      page_type: "runbook",
      project: "vega",
      tags: ["sqlite", "setup"],
      source_memory_ids: ["memory-1"],
      auto_generated: false
    });

    assert.match(page.id, /^[0-9a-f-]{36}$/);
    assert.equal(page.slug, "sqlite-setup-guide");
    assert.equal(page.title, "SQLite Setup Guide");
    assert.equal(page.page_type, "runbook");
    assert.equal(page.scope, "project");
    assert.equal(page.project, "vega");
    assert.deepEqual(page.tags, ["sqlite", "setup"]);
    assert.deepEqual(page.source_memory_ids, ["memory-1"]);
    assert.equal(page.status, "draft");
    assert.equal(page.auto_generated, false);
    assert.equal(page.reviewed, false);
    assert.equal(page.version, 1);
    assert.equal(page.parent_id, null);
    assert.equal(page.sort_order, 0);
    assert.equal(page.reviewed_at, null);
    assert.equal(page.published_at, null);
    assert.ok(page.created_at.length > 0);
    assert.equal(page.updated_at, page.created_at);
  } finally {
    repository.close();
  }
});

test("createPage auto-deduplicates slugs", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);

  try {
    const first = pageManager.createPage({
      title: "Deployment Checklist",
      content: "Run smoke tests.",
      summary: "Deployment checklist.",
      page_type: "runbook"
    });
    const second = pageManager.createPage({
      title: "Deployment Checklist",
      content: "Verify health checks.",
      summary: "Second deployment checklist.",
      page_type: "runbook"
    });

    assert.equal(first.slug, "deployment-checklist");
    assert.equal(second.slug, "deployment-checklist-2");
  } finally {
    repository.close();
  }
});

test("getPage resolves by id and slug", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);

  try {
    const page = pageManager.createPage({
      title: "Knowledge Base Entry",
      content: "Useful content.",
      summary: "Useful summary.",
      page_type: "reference"
    });

    assert.deepEqual(pageManager.getPage(page.id), page);
    assert.deepEqual(pageManager.getPage(page.slug), page);
  } finally {
    repository.close();
  }
});

test("getPageWithBacklinks returns backlinks", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);

  try {
    const source = pageManager.createPage({
      title: "SQLite Decisions",
      content: "Reference the WAL runbook.",
      summary: "Decision log for SQLite.",
      page_type: "decision_log"
    });
    const target = pageManager.createPage({
      title: "WAL Runbook",
      content: "Enable WAL mode for writes.",
      summary: "Runbook for WAL mode.",
      page_type: "runbook"
    });

    pageManager.addCrossReference(source.id, target.id, "See the WAL runbook.");

    const result = pageManager.getPageWithBacklinks(target.id);

    assert.ok(result);
    assert.equal(result.page.id, target.id);
    assert.deepEqual(result.backlinks, [
      {
        page_id: source.id,
        title: source.title,
        slug: source.slug,
        context: "See the WAL runbook."
      }
    ]);
  } finally {
    repository.close();
  }
});

test("updatePage creates version history and increments version", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);

  try {
    const page = pageManager.createPage({
      title: "Cache Strategy",
      content: "Use a small in-memory cache.",
      summary: "Initial cache strategy.",
      page_type: "topic",
      tags: ["cache"]
    });

    const updated = pageManager.updatePage(
      page.id,
      {
        content: "Use a small in-memory cache with invalidation.",
        summary: "Updated cache strategy.",
        tags: ["cache", "invalidation"]
      },
      "Clarified cache invalidation"
    );
    const versions = pageManager.getVersions(page.id);

    assert.equal(updated.version, 2);
    assert.equal(updated.content, "Use a small in-memory cache with invalidation.");
    assert.deepEqual(updated.tags, ["cache", "invalidation"]);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].page_id, page.id);
    assert.equal(versions[0].version, 1);
    assert.equal(versions[0].content, "Use a small in-memory cache.");
    assert.equal(versions[0].summary, "Initial cache strategy.");
    assert.equal(versions[0].change_reason, "Clarified cache invalidation");
  } finally {
    repository.close();
  }
});

test("deletePage removes page and cascades", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);

  try {
    const source = pageManager.createPage({
      title: "Source Page",
      content: "Source content.",
      summary: "Source summary.",
      page_type: "topic"
    });
    const target = pageManager.createPage({
      title: "Target Page",
      content: "Target content.",
      summary: "Target summary.",
      page_type: "topic"
    });

    pageManager.updatePage(source.id, { content: "Updated source content." }, "Snapshot before delete");
    pageManager.addCrossReference(source.id, target.id, "References target page.");

    pageManager.deletePage(source.id);

    const versionCount = repository.db
      .prepare<[string], { total: number }>(
        "SELECT COUNT(*) AS total FROM wiki_page_versions WHERE page_id = ?"
      )
      .get(source.id);
    const referenceCount = repository.db
      .prepare<[string, string], { total: number }>(
        "SELECT COUNT(*) AS total FROM wiki_cross_references WHERE source_page_id = ? OR target_page_id = ?"
      )
      .get(source.id, source.id);
    const ftsCount = repository.db
      .prepare<[string], { total: number }>(
        `SELECT COUNT(*) AS total
         FROM wiki_pages_fts
         JOIN wiki_pages ON wiki_pages.rowid = wiki_pages_fts.rowid
         WHERE wiki_pages.id = ?`
      )
      .get(source.id);

    assert.equal(pageManager.getPage(source.id), null);
    assert.equal(versionCount?.total ?? 0, 0);
    assert.equal(referenceCount?.total ?? 0, 0);
    assert.equal(ftsCount?.total ?? 0, 0);
  } finally {
    repository.close();
  }
});

test("listPages supports filters", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);

  try {
    const parent = pageManager.createPage({
      title: "Project Docs",
      content: "Parent content.",
      summary: "Parent summary.",
      page_type: "project",
      project: "vega"
    });
    const child = pageManager.createPage({
      title: "Build Runbook",
      content: "Run npm run build.",
      summary: "Build steps.",
      page_type: "runbook",
      project: "vega",
      parent_id: parent.id
    });
    const globalReference = pageManager.createPage({
      title: "Global Reference",
      content: "Shared content.",
      summary: "Shared summary.",
      page_type: "reference",
      scope: "global",
      project: null
    });
    pageManager.updatePage(child.id, { status: "published" }, "Publish runbook");

    const byProject = pageManager.listPages({ project: "vega", sort: "created_at ASC" });
    const byType = pageManager.listPages({ page_type: "runbook" });
    const byStatus = pageManager.listPages({ status: "published" });
    const byParent = pageManager.listPages({ parent_id: parent.id });
    const roots = pageManager.listPages({ parent_id: null, sort: "created_at ASC" });

    assert.equal(byProject.length, 2);
    assert.deepEqual(
      [...byProject.map((page) => page.id)].sort(),
      [parent.id, child.id].sort()
    );
    assert.equal(byType.length, 1);
    assert.equal(byType[0].id, child.id);
    assert.equal(byStatus.length, 1);
    assert.equal(byStatus[0].id, child.id);
    assert.equal(byParent.length, 1);
    assert.equal(byParent[0].id, child.id);
    assert.deepEqual(
      [...roots.map((page) => page.id)].sort(),
      [parent.id, globalReference.id].sort()
    );
  } finally {
    repository.close();
  }
});

test("findStalePages returns old auto-generated pages", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);

  try {
    const staleCandidate = pageManager.createPage({
      title: "Old Auto Page",
      content: "Generated content.",
      summary: "Generated summary.",
      page_type: "topic"
    });
    const reviewedPage = pageManager.createPage({
      title: "Reviewed Page",
      content: "Reviewed content.",
      summary: "Reviewed summary.",
      page_type: "topic"
    });
    const manualPage = pageManager.createPage({
      title: "Manual Page",
      content: "Manual content.",
      summary: "Manual summary.",
      page_type: "topic",
      auto_generated: false
    });

    const oldTimestamp = "2025-01-01T00:00:00.000Z";

    repository.db
      .prepare<[string, string]>(
        "UPDATE wiki_pages SET status = 'published', updated_at = ? WHERE id = ?"
      )
      .run(oldTimestamp, staleCandidate.id);
    repository.db
      .prepare<[string, string]>(
        "UPDATE wiki_pages SET status = 'published', updated_at = ?, reviewed = 1 WHERE id = ?"
      )
      .run(oldTimestamp, reviewedPage.id);
    repository.db
      .prepare<[string, string]>(
        "UPDATE wiki_pages SET status = 'published', updated_at = ? WHERE id = ?"
      )
      .run(oldTimestamp, manualPage.id);

    const stalePages = pageManager.findStalePages(undefined, 30);

    assert.deepEqual(
      stalePages.map((page) => page.id),
      [staleCandidate.id]
    );
  } finally {
    repository.close();
  }
});

test("content source helpers create list and mark processed records", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);

  try {
    const created = pageManager.createContentSource({
      source_type: "web_article",
      url: "https://example.com/wiki",
      title: "Wiki design notes",
      raw_content: "Raw article content",
      project: "vega",
      tags: ["wiki", "design"]
    });

    let pending = pageManager.listContentSources({ processed: false });

    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, created.id);
    assert.equal(pending[0].processed, false);
    assert.deepEqual(pending[0].tags, ["wiki", "design"]);

    pageManager.markContentSourceProcessed(created.id);

    pending = pageManager.listContentSources({ processed: false });
    const processed = pageManager.listContentSources({ processed: true });
    const byType = pageManager.listContentSources({ source_type: "web_article", limit: 1 });

    assert.equal(pending.length, 0);
    assert.equal(processed.length, 1);
    assert.equal(processed[0].id, created.id);
    assert.equal(processed[0].processed, true);
    assert.equal(byType.length, 1);
    assert.equal(byType[0].id, created.id);
  } finally {
    repository.close();
  }
});

test("wiki_pages_fts supports direct FTS queries", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);

  try {
    const page = pageManager.createPage({
      title: "SQLite Tuning",
      content: "SQLite tuning covers WAL mode and pragma cache_size.",
      summary: "Tune SQLite with WAL mode.",
      page_type: "reference",
      tags: ["sqlite", "performance"]
    });

    const rows = repository.db
      .prepare<[string], { id: string; rank: number }>(
        `SELECT wiki_pages.id AS id, bm25(wiki_pages_fts) AS rank
         FROM wiki_pages_fts
         JOIN wiki_pages ON wiki_pages.rowid = wiki_pages_fts.rowid
         WHERE wiki_pages_fts MATCH ?
         ORDER BY rank`
      )
      .all("WAL");

    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, page.id);
    assert.equal(typeof rows[0].rank, "number");
  } finally {
    repository.close();
  }
});
