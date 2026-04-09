import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { MemoryService } from "../core/memory.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { ContentDistiller } from "../ingestion/distiller.js";
import { ContentFetcher } from "../ingestion/fetcher.js";
import { RSSService } from "../ingestion/rss.js";
import { IngestionService } from "../ingestion/service.js";
import { createMCPServer } from "../mcp/server.js";
import { PageManager } from "../wiki/page-manager.js";
import { SynthesisEngine } from "../wiki/synthesis.js";

const testConfig: VegaConfig = {
  dbPath: ":memory:",
  dbEncryption: false,
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "test-chat-model",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
};

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  tenant_id: null,
  type: "project_context",
  project: "vega",
  title: "Seed memory",
  content: "Seed content.",
  summary: null,
  embedding: null,
  importance: 0.8,
  source: "explicit",
  tags: ["alpha"],
  created_at: "2026-04-06T00:00:00.000Z",
  updated_at: "2026-04-06T00:00:00.000Z",
  accessed_at: "2026-04-06T00:00:00.000Z",
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const installFetchMock = (options: {
  responses?: Record<
    string,
    {
      body: string;
      status?: number;
      contentType?: string;
    }
  >;
  chatResponder?: (body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
  }) => string;
  embedResponder?: (body: { model: string; input: string }) => number[];
  embedding?: number[];
}) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/api/chat")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      const content = options.chatResponder
        ? options.chatResponder(body)
        : '{"type":"project_context","title":"Default takeaway","content":"Default takeaway.","tags":["default"]}';

      return new Response(
        JSON.stringify({
          message: { content }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.includes("/api/embed")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        model: string;
        input: string;
      };
      return new Response(
        JSON.stringify({
          embeddings: [
            options.embedResponder
              ? options.embedResponder(body)
              : (options.embedding ?? Array.from({ length: 8 }, () => 0.1))
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    const response = options.responses?.[url];
    if (response) {
      return new Response(response.body, {
        status: response.status ?? 200,
        headers: {
          "content-type": response.contentType ?? "text/html; charset=utf-8"
        }
      });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
};

const createHarness = () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const memoryService = new MemoryService(repository, testConfig);
  const synthesisEngine = new SynthesisEngine(repository, pageManager, testConfig);
  const fetcher = new ContentFetcher();
  const distiller = new ContentDistiller(testConfig);
  const ingestionService = new IngestionService(
    fetcher,
    distiller,
    pageManager,
    memoryService,
    synthesisEngine,
    testConfig
  );
  const rssService = new RSSService(repository);

  return {
    repository,
    pageManager,
    memoryService,
    synthesisEngine,
    fetcher,
    distiller,
    ingestionService,
    rssService
  };
};

const getRegisteredTools = (
  server: ReturnType<typeof createMCPServer>
): Record<
  string,
  {
    handler: (
      args: Record<string, unknown>,
      extra: object
    ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
  }
> =>
  (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
            extra: object
          ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
        }
      >;
    }
  )._registeredTools;

const parseToolPayload = <T>(result: {
  content: Array<{ text?: string }>;
}): T => JSON.parse(result.content[0]?.text ?? "{}") as T;

test("fetchUrl extracts content from HTML", async () => {
  const restore = installFetchMock({
    responses: {
      "https://example.com/post": {
        body: `<!doctype html>
          <html>
            <head>
              <title>Example Article</title>
              <meta name="author" content="Jane Doe">
              <meta property="article:published_time" content="2026-04-06T12:00:00Z">
            </head>
            <body>
              <nav>ignore me</nav>
              <article>
                <h1>Main heading</h1>
                <p>Hello <a href="/docs">docs</a>.</p>
                <ul><li>First item</li></ul>
              </article>
            </body>
          </html>`
      }
    }
  });
  const { repository, fetcher } = createHarness();

  try {
    const extracted = await fetcher.fetchUrl("https://example.com/post");

    assert.equal(extracted.title, "Example Article");
    assert.equal(extracted.author, "Jane Doe");
    assert.equal(extracted.published_at, "2026-04-06T12:00:00.000Z");
    assert.equal(extracted.language, "en");
    assert.match(extracted.content, /# Main heading/);
    assert.match(extracted.content, /\[docs\]\(https:\/\/example.com\/docs\)/);
    assert.match(extracted.content, /- First item/);
    assert.ok(extracted.word_count > 0);
  } finally {
    restore();
    repository.close();
  }
});

test("fetchFile reads markdown file", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-ingest-file-"));
  const filePath = join(tempDir, "release-notes.md");
  const { repository, fetcher } = createHarness();

  try {
    writeFileSync(filePath, "# Release Notes\n\nShip the new ingestion pipeline.\n", "utf8");

    const extracted = await fetcher.fetchFile(filePath);

    assert.equal(extracted.title, "release notes");
    assert.equal(extracted.content, "# Release Notes\n\nShip the new ingestion pipeline.");
    assert.equal(extracted.language, "en");
    assert.ok(extracted.word_count > 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    repository.close();
  }
});

test("distill extracts memories from content", async () => {
  const restore = installFetchMock({
    chatResponder: () =>
      [
        '{"type":"decision","title":"Use feed polling","content":"Poll the feed hourly.","tags":["rss","polling"]}',
        '{"type":"project_context","title":"Content pipeline","content":"Pipeline stores distilled takeaways.","tags":["ingestion"]}'
      ].join("\n")
  });
  const { repository, distiller } = createHarness();

  try {
    const memories = await distiller.distill("Feed updates are summarized hourly.", "RSS Notes", "vega");

    assert.equal(memories.length, 2);
    assert.deepEqual(memories[0], {
      type: "decision",
      title: "Use feed polling",
      content: "Poll the feed hourly.",
      tags: ["rss", "polling"]
    });
    assert.equal(memories[1]?.type, "project_context");
  } finally {
    restore();
    repository.close();
  }
});

test("ingest end-to-end stores content source and distilled memories", async () => {
  const restore = installFetchMock({
    responses: {
      "https://example.com/article": {
        body: `<!doctype html>
          <html>
            <head><title>Alpha Update</title></head>
            <body>
              <article>
                <h1>Alpha Update</h1>
                <p>Short update for the alpha topic.</p>
              </article>
            </body>
          </html>`
      }
    },
    chatResponder: (body) => {
      const system = body.messages[0]?.content ?? "";
      if (system.includes("knowledge extraction engine")) {
        return '{"type":"project_context","title":"Alpha update","content":"Alpha ingestion added a new pipeline step.","tags":["alpha"]}';
      }

      return "Short summary";
    }
  });
  const { repository, pageManager, ingestionService } = createHarness();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-a",
        title: "Alpha seed 1",
        content: "Existing alpha context one.",
        tags: ["alpha"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-b",
        title: "Alpha seed 2",
        content: "Existing alpha context two.",
        tags: ["alpha"]
      })
    );

    const result = await ingestionService.ingest({
      url: "https://example.com/article",
      project: "vega",
      tags: ["news"]
    });
    const sources = pageManager.listContentSources({ processed: true, limit: 10 });
    const memories = repository.listMemories({ project: "vega", limit: 10 });

    assert.equal(result.memories_created, 1);
    assert.equal(result.memory_ids.length, 1);
    assert.equal(result.synthesis_queued, true);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.title, "Alpha Update");
    assert.equal(sources[0]?.processed, true);
    assert.equal(memories.length, 3);
  } finally {
    restore();
    repository.close();
  }
});

test("quickNote stores memory directly", async () => {
  const restore = installFetchMock({});
  const { repository, ingestionService } = createHarness();

  try {
    const id = await ingestionService.quickNote(
      "Rotate the deployment key after publishing.",
      "security",
      "vega",
      ["ops"]
    );
    const memory = repository.getMemory(id);

    assert.ok(memory);
    assert.equal(memory.type, "project_context");
    assert.equal(memory.project, "vega");
    assert.deepEqual(memory.tags.sort(), ["ops", "security"]);
    assert.equal(memory.verified, "verified");
  } finally {
    restore();
    repository.close();
  }
});

test("RSS addFeed parses feed title", async () => {
  const restore = installFetchMock({
    responses: {
      "https://example.com/feed.xml": {
        body: `<?xml version="1.0"?>
          <rss>
            <channel>
              <title>Vega Feed</title>
            </channel>
          </rss>`,
        contentType: "application/rss+xml"
      }
    }
  });
  const { repository, rssService } = createHarness();

  try {
    const result = await rssService.addFeed("https://example.com/feed.xml", "vega");
    const feeds = rssService.listFeeds();

    assert.equal(result.title, "Vega Feed");
    assert.equal(feeds.length, 1);
    assert.equal(feeds[0]?.title, "Vega Feed");
    assert.equal(feeds[0]?.project, "vega");
  } finally {
    restore();
    repository.close();
  }
});

test("RSS pollFeed processes new entries", async () => {
  const restore = installFetchMock({
    responses: {
      "https://example.com/feed.xml": {
        body: `<?xml version="1.0"?>
          <rss>
            <channel>
              <title>Vega Feed</title>
              <item>
                <title>First entry</title>
                <link>https://example.com/articles/1</link>
                <pubDate>Sun, 06 Apr 2026 12:00:00 GMT</pubDate>
              </item>
              <item>
                <title>Second entry</title>
                <link>https://example.com/articles/2</link>
                <pubDate>Mon, 07 Apr 2026 12:00:00 GMT</pubDate>
              </item>
            </channel>
          </rss>`,
        contentType: "application/rss+xml"
      },
      "https://example.com/articles/1": {
        body: `<!doctype html><html><head><title>First entry</title></head><body><article><h1>First entry</h1><p>First article body.</p></article></body></html>`
      },
      "https://example.com/articles/2": {
        body: `<!doctype html><html><head><title>Second entry</title></head><body><article><h1>Second entry</h1><p>Second article body.</p></article></body></html>`
      }
    },
    chatResponder: (body) => {
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.includes("knowledge extraction engine")) {
        if (user.includes("First entry")) {
          return '{"type":"project_context","title":"First feed memory","content":"First feed takeaway.","tags":["rss-test"]}';
        }

        return '{"type":"project_context","title":"Second feed memory","content":"Second feed takeaway.","tags":["rss-test"]}';
      }

      return "Short summary";
    },
    embedResponder: (body) =>
      body.input.includes("Second")
        ? [0.2, 0.1, 0.3, 0.5, 0.7, 0.1, 0.2, 0.4]
        : [0.9, 0.3, 0.1, 0.2, 0.1, 0.8, 0.4, 0.2]
  });
  const { repository, pageManager, memoryService, fetcher, distiller, rssService } = createHarness();

  try {
    await rssService.addFeed("https://example.com/feed.xml", "vega");
    const feed = rssService.listFeeds()[0];
    assert.ok(feed);
    const processed = await rssService.pollFeed(
      feed,
      fetcher,
      distiller,
      pageManager,
      memoryService,
      testConfig
    );
    const sources = pageManager.listContentSources({ source_type: "rss", processed: true, limit: 10 });
    const memories = repository.listMemories({ project: "vega", limit: 10 });

    assert.equal(processed, 2);
    assert.equal(sources.length, 2);
    assert.equal(memories.length, 2);
    assert.equal(rssService.listFeeds()[0]?.last_polled_at !== null, true);
  } finally {
    restore();
    repository.close();
  }
});

test("wiki_ingest MCP tool works", async () => {
  const restore = installFetchMock({
    chatResponder: (body) => {
      const system = body.messages[0]?.content ?? "";
      if (system.includes("knowledge extraction engine")) {
        return '{"type":"project_context","title":"Alpha tool memory","content":"Alpha tool ingestion created a distilled memory.","tags":["alpha"]}';
      }

      return "Short summary";
    }
  });
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const memoryService = new MemoryService(repository, testConfig);
  const emptyGraphService = {
    query: () => ({
      entity: null,
      relations: [],
      memories: []
    }),
    getNeighbors: () => ({
      entity: null,
      neighbors: [],
      relations: [],
      memories: []
    }),
    shortestPath: () => ({
      from: null,
      to: null,
      entities: [],
      relations: [],
      memories: [],
      found: false
    }),
    graphStats: () => ({
      total_entities: 0,
      total_relations: 0,
      entity_types: {},
      relation_types: {},
      average_confidence: null,
      tracked_code_files: 0,
      tracked_doc_files: 0
    }),
    subgraph: () => ({
      seed_entities: [],
      missing_entities: [],
      entities: [],
      relations: [],
      memories: []
    })
  };
  const server = createMCPServer({
    repository,
    graphService: emptyGraphService,
    memoryService,
    recallService: {
      recall: async () => [],
      listMemories: () => []
    },
    sessionService: {
      sessionStart: async () => ({
        project: "vega",
        active_tasks: [],
        preferences: [],
        context: [],
        relevant: [],
        relevant_wiki_pages: [],
        wiki_drafts_pending: 0,
        recent_unverified: [],
        conflicts: [],
        proactive_warnings: [],
        token_estimate: 0
      }),
      sessionEnd: async () => {}
    },
    compactService: {
      compact: () => ({ merged: 0, archived: 0 })
    },
    config: testConfig
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-c",
        title: "Alpha seed 1",
        content: "Existing alpha detail one.",
        tags: ["alpha"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-d",
        title: "Alpha seed 2",
        content: "Existing alpha detail two.",
        tags: ["alpha"]
      })
    );

    const result = await getRegisteredTools(server).wiki_ingest.handler(
      {
        content: "Manual alpha content",
        title: "Alpha note",
        project: "vega"
      },
      {}
    );
    const payload = parseToolPayload<{
      source_id: string;
      memories_created: number;
      synthesis_queued: boolean;
    }>(result);

    assert.ok(payload.source_id.length > 0);
    assert.equal(payload.memories_created, 1);
    assert.equal(payload.synthesis_queued, true);
    assert.equal(pageManager.listContentSources({ processed: true, limit: 10 }).length, 1);
  } finally {
    restore();
    repository.close();
    await server.close();
  }
});
