import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Repository } from "../db/repository.js";
import {
  MISSING_NOTION_PUBLISH_CONFIG_MESSAGE,
  NotionPublisher
} from "../publishing/notion.js";
import { ObsidianPublisher } from "../publishing/obsidian.js";
import { StaticExporter } from "../publishing/static-export.js";
import { PageManager } from "../wiki/page-manager.js";
import type { WikiPageType } from "../wiki/types.js";

const createPublishedPage = (
  pageManager: PageManager,
  title: string,
  pageType: WikiPageType,
  content: string,
  project = "vega"
) => {
  const page = pageManager.createPage({
    title,
    content,
    summary: `${title} summary`,
    page_type: pageType,
    project
  });

  return pageManager.updatePage(
    page.id,
    {
      status: "published",
      reviewed: true,
      reviewed_at: "2026-04-07T00:00:00.000Z",
      published_at: "2026-04-07T00:00:00.000Z"
    },
    "Seed published page"
  );
};

const withFetchMock = (
  handler: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>
): (() => void) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
};

test("ObsidianPublisher.publishPage creates markdown file with front matter", () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const vaultDir = mkdtempSync(join(tmpdir(), "vega-obsidian-page-"));

  try {
    const page = createPublishedPage(
      pageManager,
      "SQLite Setup Guide",
      "runbook",
      "Enable WAL mode before first write."
    );
    const publisher = new ObsidianPublisher(pageManager, vaultDir);
    const filePath = publisher.publishPage(page);
    const content = readFileSync(filePath, "utf8");

    assert.equal(existsSync(filePath), true);
    assert.match(content, /^---\npage_id:/);
    assert.match(content, /title: "SQLite Setup Guide"/);
    assert.match(content, /page_type: "runbook"/);
    assert.match(content, /status: "published"/);
    assert.match(content, /Enable WAL mode before first write\./);
  } finally {
    repository.close();
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("ObsidianPublisher.publishAll generates index.md", () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const vaultDir = mkdtempSync(join(tmpdir(), "vega-obsidian-index-"));

  try {
    const first = createPublishedPage(pageManager, "Auth Topic", "topic", "Auth content");
    const second = createPublishedPage(pageManager, "Deploy Runbook", "runbook", "Deploy content");
    const publisher = new ObsidianPublisher(pageManager, vaultDir);
    const result = publisher.publishAll();
    const indexPath = join(vaultDir, "index.md");
    const indexContent = readFileSync(indexPath, "utf8");

    assert.equal(result.published, 2);
    assert.equal(existsSync(indexPath), true);
    assert.match(indexContent, /## Topics/);
    assert.match(indexContent, new RegExp(`\\[\\[${first.slug}\\]\\]`));
    assert.match(indexContent, new RegExp(`\\[\\[${second.slug}\\]\\]`));
  } finally {
    repository.close();
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("ObsidianPublisher preserves [[wiki-links]]", () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const vaultDir = mkdtempSync(join(tmpdir(), "vega-obsidian-links-"));

  try {
    const page = createPublishedPage(
      pageManager,
      "Cross Reference Topic",
      "topic",
      "See [[deploy-runbook]] before rollout."
    );
    const publisher = new ObsidianPublisher(pageManager, vaultDir);
    const filePath = publisher.publishPage(page);
    const content = readFileSync(filePath, "utf8");

    assert.match(content, /\[\[deploy-runbook\]\]/);
  } finally {
    repository.close();
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

test("NotionPublisher.publishPage calls Notion API", async () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const restoreFetch = withFetchMock(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/databases/notion-db")) {
      return new Response(
        JSON.stringify({
          properties: {
            Title: { type: "title" },
            Type: { type: "rich_text" },
            Project: { type: "rich_text" },
            Status: { type: "rich_text" },
            Tags: { type: "multi_select" }
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/pages")) {
      return new Response(
        JSON.stringify({
          id: "notion-page-1"
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  try {
    const page = createPublishedPage(
      pageManager,
      "Publish Topic",
      "topic",
      "# Heading\n\n- First item\n\nParagraph body."
    );
    const publisher = new NotionPublisher(pageManager, {
      apiKey: "secret",
      databaseId: "notion-db"
    });
    const result = await publisher.publishPage(page);
    const createCall = calls.find((call) => call.url.endsWith("/pages"));
    const createPayload = JSON.parse(String(createCall?.init?.body ?? "{}")) as {
      parent: { database_id: string };
      properties: Record<string, unknown>;
      children: Array<{ type: string }>;
    };

    assert.equal(result.notionPageId, "notion-page-1");
    assert.equal(
      repository.getMetadata(`notion_page_id:${page.id}`),
      "notion-page-1"
    );
    assert.equal(createPayload.parent.database_id, "notion-db");
    assert.equal(createPayload.children[0]?.type, "heading_1");
    assert.equal(createPayload.children[1]?.type, "bulleted_list_item");
    assert.ok(createPayload.properties.Title);
    assert.ok(createPayload.properties.Tags);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("NotionPublisher.publishPage batches create children above 100 blocks", async () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const createPayloads: Array<{ children?: Array<{ type: string }> }> = [];
  const appendPayloads: Array<{ children: Array<{ type: string }> }> = [];
  const restoreFetch = withFetchMock(async (input, init) => {
    const url = String(input);

    if (url.endsWith("/databases/notion-db")) {
      return new Response(
        JSON.stringify({
          properties: {
            Title: { type: "title" },
            Type: { type: "rich_text" },
            Project: { type: "rich_text" },
            Status: { type: "rich_text" },
            Tags: { type: "multi_select" }
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/pages")) {
      createPayloads.push(
        JSON.parse(String(init?.body ?? "{}")) as { children?: Array<{ type: string }> }
      );
      return new Response(
        JSON.stringify({
          id: "notion-page-1"
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/blocks/notion-page-1/children")) {
      appendPayloads.push(
        JSON.parse(String(init?.body ?? "{}")) as { children: Array<{ type: string }> }
      );
      return new Response(
        JSON.stringify({
          results: []
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  try {
    const content = Array.from({ length: 101 }, (_, index) => `- Item ${index + 1}`).join("\n");
    const page = createPublishedPage(pageManager, "Large Publish Topic", "topic", content);
    const publisher = new NotionPublisher(pageManager, {
      apiKey: "secret",
      databaseId: "notion-db"
    });

    await publisher.publishPage(page);

    assert.equal(createPayloads.length, 1);
    assert.equal(createPayloads[0]?.children?.length, 100);
    assert.equal(appendPayloads.length, 1);
    assert.equal(appendPayloads[0]?.children.length, 1);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("NotionPublisher.publishAll retries database schema fetch after a transient failure", async () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  let databaseRequestCount = 0;
  let pageCreateCount = 0;
  const restoreFetch = withFetchMock(async (input, init) => {
    const url = String(input);

    if (url.endsWith("/databases/notion-db")) {
      databaseRequestCount += 1;

      if (databaseRequestCount === 1) {
        return new Response("temporary failure", { status: 500 });
      }

      return new Response(
        JSON.stringify({
          properties: {
            Title: { type: "title" },
            Type: { type: "rich_text" },
            Project: { type: "rich_text" },
            Status: { type: "rich_text" },
            Tags: { type: "multi_select" }
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/pages")) {
      pageCreateCount += 1;
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        properties: {
          Title?: {
            title?: Array<{ text?: { content?: string } }>;
          };
        };
      };
      const title =
        payload.properties.Title?.title?.[0]?.text?.content ?? `notion-page-${pageCreateCount}`;

      return new Response(
        JSON.stringify({
          id: `${title.toLowerCase().replace(/\s+/g, "-")}-id`
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  try {
    createPublishedPage(pageManager, "Retry Topic One", "topic", "First topic content.");
    createPublishedPage(pageManager, "Retry Topic Two", "topic", "Second topic content.");
    const publisher = new NotionPublisher(pageManager, {
      apiKey: "secret",
      databaseId: "notion-db"
    });

    const result = await publisher.publishAll();

    assert.equal(databaseRequestCount, 2);
    assert.equal(pageCreateCount, 1);
    assert.equal(result.published, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? "", /temporary failure/);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("NotionPublisher retains old content when append fails during update", async () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const deletedBlockIds: string[] = [];
  const page = createPublishedPage(pageManager, "Update Topic", "topic", "Updated content");
  repository.setMetadata(`notion_page_id:${page.id}`, "notion-page-1");
  const restoreFetch = withFetchMock(async (input, init) => {
    const url = String(input);

    if (url.endsWith("/databases/notion-db")) {
      return new Response(
        JSON.stringify({
          properties: {
            Title: { type: "title" },
            Type: { type: "rich_text" },
            Project: { type: "rich_text" },
            Status: { type: "rich_text" },
            Tags: { type: "multi_select" }
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/pages/notion-page-1")) {
      return new Response(JSON.stringify({ id: "notion-page-1" }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    if (url.includes("/blocks/notion-page-1/children?")) {
      return new Response(
        JSON.stringify({
          results: [{ id: "old-block-1" }, { id: "old-block-2" }],
          has_more: false,
          next_cursor: null
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/blocks/notion-page-1/children")) {
      return new Response("append failed", { status: 500 });
    }

    if (url.endsWith("/blocks/old-block-1") || url.endsWith("/blocks/old-block-2")) {
      deletedBlockIds.push(url.split("/").pop() ?? "");
      return new Response(undefined, { status: 204 });
    }

    throw new Error(`Unexpected fetch call: ${url} ${String(init?.method ?? "GET")}`);
  });

  try {
    const publisher = new NotionPublisher(pageManager, {
      apiKey: "secret",
      databaseId: "notion-db"
    });

    await assert.rejects(publisher.publishPage(page), /append failed/);
    assert.deepEqual(deletedBlockIds, []);
    assert.equal(repository.getMetadata(`notion_page_id:${page.id}`), "notion-page-1");
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("NotionPublisher successful update appends new content before deleting old blocks", async () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const operations: string[] = [];
  const deletedBlockIds: string[] = [];
  const page = createPublishedPage(pageManager, "Replace Topic", "topic", "Replacement body");
  repository.setMetadata(`notion_page_id:${page.id}`, "notion-page-1");
  const restoreFetch = withFetchMock(async (input, init) => {
    const url = String(input);

    if (url.endsWith("/databases/notion-db")) {
      return new Response(
        JSON.stringify({
          properties: {
            Title: { type: "title" },
            Type: { type: "rich_text" },
            Project: { type: "rich_text" },
            Status: { type: "rich_text" },
            Tags: { type: "multi_select" }
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/pages/notion-page-1")) {
      operations.push("update-page");
      return new Response(JSON.stringify({ id: "notion-page-1" }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    if (url.includes("/blocks/notion-page-1/children?")) {
      operations.push("list-old-blocks");
      return new Response(
        JSON.stringify({
          results: [{ id: "old-block-1" }, { id: "old-block-2" }],
          has_more: false,
          next_cursor: null
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/blocks/notion-page-1/children")) {
      operations.push("append-new-blocks");
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    if (url.endsWith("/blocks/old-block-1") || url.endsWith("/blocks/old-block-2")) {
      operations.push(`delete-${url.split("/").pop() ?? ""}`);
      deletedBlockIds.push(url.split("/").pop() ?? "");
      return new Response(undefined, { status: 204 });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  try {
    const publisher = new NotionPublisher(pageManager, {
      apiKey: "secret",
      databaseId: "notion-db"
    });

    const result = await publisher.publishPage(page);

    assert.equal(result.notionPageId, "notion-page-1");
    assert.deepEqual(deletedBlockIds, ["old-block-1", "old-block-2"]);
    assert.equal(operations.indexOf("append-new-blocks") > operations.indexOf("list-old-blocks"), true);
    assert.equal(operations.indexOf("delete-old-block-1") > operations.indexOf("append-new-blocks"), true);
    assert.equal(operations.indexOf("delete-old-block-2") > operations.indexOf("append-new-blocks"), true);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("NotionPublisher handles missing config", () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);

  try {
    assert.throws(
      () =>
        new NotionPublisher(pageManager, {
          apiKey: "",
          databaseId: ""
        }),
      new RegExp(MISSING_NOTION_PUBLISH_CONFIG_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  } finally {
    repository.close();
  }
});

test("StaticExporter converts [[slug]] to relative links in markdown format", () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const outputDir = mkdtempSync(join(tmpdir(), "vega-static-links-"));

  try {
    const target = createPublishedPage(pageManager, "Target Topic", "topic", "Target content");
    createPublishedPage(
      pageManager,
      "Source Topic",
      "topic",
      `Read [[${target.slug}]] before deployment.`
    );
    const exporter = new StaticExporter(pageManager);

    exporter.exportAll(outputDir, "markdown");

    const sourcePath = join(outputDir, "topics", "source-topic.md");
    const content = readFileSync(sourcePath, "utf8");

    assert.match(content, /\[Target Topic\]\(\.\/target-topic\.md\)/);
  } finally {
    repository.close();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("StaticExporter.exportAll creates directory structure", () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const outputDir = mkdtempSync(join(tmpdir(), "vega-static-structure-"));

  try {
    createPublishedPage(pageManager, "Topic Page", "topic", "Topic content");
    createPublishedPage(pageManager, "Runbook Page", "runbook", "Runbook content");
    const exporter = new StaticExporter(pageManager);
    const result = exporter.exportAll(outputDir, "obsidian");

    assert.equal(result.exported, 2);
    assert.equal(existsSync(join(outputDir, "topics", "topic-page.md")), true);
    assert.equal(existsSync(join(outputDir, "runbooks", "runbook-page.md")), true);
    assert.equal(existsSync(join(outputDir, "index.md")), true);
  } finally {
    repository.close();
    rmSync(outputDir, { recursive: true, force: true });
  }
});
