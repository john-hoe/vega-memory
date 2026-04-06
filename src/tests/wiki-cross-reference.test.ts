import assert from "node:assert/strict";
import test from "node:test";

import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { CrossReferenceService } from "../wiki/cross-reference.js";
import { PageManager } from "../wiki/page-manager.js";
import { StalenessService } from "../wiki/staleness.js";

const createHarness = () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const crossReferenceService = new CrossReferenceService(pageManager);
  const stalenessService = new StalenessService(pageManager, repository);

  return {
    repository,
    pageManager,
    crossReferenceService,
    stalenessService
  };
};

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  tenant_id: null,
  type: "insight",
  project: "vega",
  title: "Auth memory",
  content: "Auth configuration changed for the wiki pipeline.",
  summary: null,
  embedding: null,
  importance: 0.8,
  source: "explicit",
  tags: ["auth"],
  created_at: "2026-04-06T00:00:00.000Z",
  updated_at: "2026-04-06T00:00:00.000Z",
  accessed_at: "2026-04-06T00:00:00.000Z",
  status: "active",
  verified: "unverified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

test("extractWikiLinks parses [[slug]] from content", () => {
  const { repository, crossReferenceService } = createHarness();

  try {
    const links = crossReferenceService.extractWikiLinks(
      "Link to [[foo-bar]] and [[baz]] with another [[foo-bar]]."
    );

    assert.deepEqual(links, ["foo-bar", "baz"]);
  } finally {
    repository.close();
  }
});

test("extractWikiLinks ignores links in code blocks", () => {
  const { repository, crossReferenceService } = createHarness();

  try {
    const links = crossReferenceService.extractWikiLinks(`
Reference [[visible-link]] in text.
\`[[hidden-inline]]\`

\`\`\`
[[hidden-fenced]]
\`\`\`
`);

    assert.deepEqual(links, ["visible-link"]);
  } finally {
    repository.close();
  }
});

test("updateCrossReferences creates cross-reference records", () => {
  const { repository, pageManager, crossReferenceService } = createHarness();

  try {
    const pageB = pageManager.createPage({
      title: "Page B Slug",
      content: "Target page.",
      summary: "Target summary.",
      page_type: "reference"
    });
    const pageA = pageManager.createPage({
      title: "Page A",
      content: `Refer to [[${pageB.slug}]] for details.`,
      summary: "Source summary.",
      page_type: "reference"
    });

    const result = crossReferenceService.updateCrossReferences(pageA);
    const backlinks = pageManager.getBacklinks(pageB.id);

    assert.deepEqual(result, { added: 1, removed: 0 });
    assert.equal(backlinks.length, 1);
    assert.equal(backlinks[0].page_id, pageA.id);
    assert.equal(backlinks[0].slug, pageA.slug);
    assert.match(backlinks[0].context, /\[\[page-b-slug\]\]/);
  } finally {
    repository.close();
  }
});

test("updateCrossReferences removes stale references", () => {
  const { repository, pageManager, crossReferenceService } = createHarness();

  try {
    const target = pageManager.createPage({
      title: "Target Page",
      content: "Target content.",
      summary: "Target summary.",
      page_type: "reference"
    });
    const source = pageManager.createPage({
      title: "Source Page",
      content: `See [[${target.slug}]].`,
      summary: "Source summary.",
      page_type: "reference"
    });

    crossReferenceService.updateCrossReferences(source);
    const updatedSource = pageManager.updatePage(
      source.id,
      { content: "See the target page without a wiki link." },
      "Removed wiki link"
    );
    const result = crossReferenceService.updateCrossReferences(updatedSource);

    assert.deepEqual(result, { added: 0, removed: 1 });
    assert.deepEqual(pageManager.getBacklinks(target.id), []);
  } finally {
    repository.close();
  }
});

test("injectWikiLinks adds links for known page titles", () => {
  const { repository, pageManager, crossReferenceService } = createHarness();

  try {
    const pageA = pageManager.createPage({
      title: "SQLite Setup Guide",
      content: "Guide content.",
      summary: "Guide summary.",
      page_type: "runbook"
    });
    const pageB = pageManager.createPage({
      title: "Auth Flow",
      content: "Auth content.",
      summary: "Auth summary.",
      page_type: "topic"
    });

    const content = "Read the SQLite Setup Guide before reviewing the auth flow.";
    const injected = crossReferenceService.injectWikiLinks(content, [pageA, pageB]);

    assert.equal(
      injected,
      `Read the [[${pageA.slug}]] before reviewing the [[${pageB.slug}]].`
    );
  } finally {
    repository.close();
  }
});

test("injectWikiLinks doesn't double-link", () => {
  const { repository, pageManager, crossReferenceService } = createHarness();

  try {
    const page = pageManager.createPage({
      title: "page-b",
      content: "Target content.",
      summary: "Target summary.",
      page_type: "reference"
    });

    const content = "Already linked as [[page-b]] in content.";
    const injected = crossReferenceService.injectWikiLinks(content, [page]);

    assert.equal(injected, content);
  } finally {
    repository.close();
  }
});

test("getBacklinks returns linking pages", () => {
  const { repository, pageManager, crossReferenceService } = createHarness();

  try {
    const target = pageManager.createPage({
      title: "Target Page",
      content: "Target content.",
      summary: "Target summary.",
      page_type: "reference"
    });
    const source = pageManager.createPage({
      title: "Source Page",
      content: `See [[${target.slug}]] for details.`,
      summary: "Source summary.",
      page_type: "reference"
    });

    crossReferenceService.updateCrossReferences(source);
    const backlinks = crossReferenceService.getBacklinks(target.id);

    assert.deepEqual(backlinks, [
      {
        page_id: source.id,
        title: source.title,
        slug: source.slug,
        context: `See [[${target.slug}]] for details`
      }
    ]);
  } finally {
    repository.close();
  }
});

test("findOrphanPages returns pages without cross-references", () => {
  const { repository, pageManager, crossReferenceService } = createHarness();

  try {
    const pageA = pageManager.createPage({
      title: "Page A",
      content: "Links to page B.",
      summary: "Page A summary.",
      page_type: "reference"
    });
    const pageB = pageManager.createPage({
      title: "Page B",
      content: "Page B content.",
      summary: "Page B summary.",
      page_type: "reference"
    });
    const pageC = pageManager.createPage({
      title: "Page C",
      content: "Standalone page.",
      summary: "Page C summary.",
      page_type: "reference"
    });

    const publishedA = pageManager.updatePage(
      pageA.id,
      {
        content: `Links to [[${pageB.slug}]].`,
        status: "published",
        published_at: "2026-04-06T00:00:00.000Z"
      },
      "Publish page A"
    );
    pageManager.updatePage(
      pageB.id,
      { status: "published", published_at: "2026-04-06T00:00:00.000Z" },
      "Publish page B"
    );
    pageManager.updatePage(
      pageC.id,
      { status: "published", published_at: "2026-04-06T00:00:00.000Z" },
      "Publish page C"
    );
    crossReferenceService.updateCrossReferences(publishedA);

    const orphans = crossReferenceService.findOrphanPages();

    assert.deepEqual(
      orphans.map((page) => page.id),
      [pageC.id]
    );
  } finally {
    repository.close();
  }
});

test("detectStalePages includes published pages with enough new tagged memories", () => {
  const { repository, pageManager, stalenessService } = createHarness();

  try {
    const page = pageManager.createPage({
      title: "Auth Overview",
      content: "Auth page content.",
      summary: "Auth summary.",
      page_type: "topic",
      project: "vega",
      tags: ["auth"],
      auto_generated: false
    });
    repository.db
      .prepare<[string, string]>(
        "UPDATE wiki_pages SET status = 'published', updated_at = ? WHERE id = ?"
      )
      .run("2026-04-01T00:00:00.000Z", page.id);
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        tags: ["auth"],
        created_at: "2026-04-02T00:00:00.000Z",
        updated_at: "2026-04-02T00:00:00.000Z",
        accessed_at: "2026-04-02T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-2",
        tags: ["auth", "wiki"],
        created_at: "2026-04-03T00:00:00.000Z",
        updated_at: "2026-04-03T00:00:00.000Z",
        accessed_at: "2026-04-03T00:00:00.000Z"
      })
    );

    const stalePages = stalenessService.detectStalePages(2);

    assert.deepEqual(
      stalePages.map((candidate) => candidate.id),
      [page.id]
    );
  } finally {
    repository.close();
  }
});

test("markStale and getStalePageSummary update stale counts", () => {
  const { repository, pageManager, stalenessService } = createHarness();

  try {
    const page = pageManager.createPage({
      title: "Build Runbook",
      content: "Runbook content.",
      summary: "Runbook summary.",
      page_type: "runbook",
      project: "vega"
    });
    pageManager.updatePage(page.id, { status: "published" }, "Publish page");

    stalenessService.markStale(page.id);
    const updatedPage = pageManager.getPage(page.id);
    const summary = stalenessService.getStalePageSummary();

    assert.equal(updatedPage?.status, "stale");
    assert.deepEqual(summary, {
      total: 1,
      byProject: {
        vega: 1
      }
    });
  } finally {
    repository.close();
  }
});
