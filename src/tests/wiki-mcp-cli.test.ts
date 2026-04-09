import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { ArchiveService } from "../core/archive-service.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { createMCPServer } from "../mcp/server.js";
import { CrossReferenceService } from "../wiki/cross-reference.js";
import { PageManager } from "../wiki/page-manager.js";
import { reviewWikiPage } from "../wiki/review.js";
import { searchWikiPages } from "../wiki/search.js";

const baseConfig: VegaConfig = {
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

const installOllamaMock = (chatContent = "## Synthesized Content\n\nAuth wiki summary.") => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/api/chat")) {
      return new Response(
        JSON.stringify({
          message: { content: chatContent }
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
      return new Response(
        JSON.stringify({
          embeddings: [Array.from({ length: 8 }, () => 0.1)]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return originalFetch(input, init);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
};

const createServerHarness = () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const crossReferenceService = new CrossReferenceService(pageManager);
  const server = createMCPServer({
    repository,
    graphService: {
      query: () => ({
        entity: null,
        relations: [],
        memories: []
      })
    },
    memoryService: {
      store: async () => ({ id: "noop", action: "created", title: "noop" }),
      update: async () => {},
      delete: async () => {}
    },
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
    config: baseConfig
  });

  return {
    repository,
    pageManager,
    crossReferenceService,
    server
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

test("wiki_list MCP tool returns pages", async () => {
  const { repository, pageManager, server } = createServerHarness();

  try {
    const first = pageManager.createPage({
      title: "SQLite Setup",
      content: "Enable WAL mode before using the wiki.",
      summary: "SQLite setup instructions.",
      page_type: "runbook",
      project: "vega"
    });
    const second = pageManager.createPage({
      title: "Auth Decisions",
      content: "Use tokens for wiki access.",
      summary: "Auth decisions.",
      page_type: "decision_log",
      project: "vega"
    });

    const result = await getRegisteredTools(server).wiki_list.handler(
      {
        project: "vega",
        limit: 20
      },
      {}
    );
    const payload = parseToolPayload<
      Array<{ id: string; slug: string; title: string; page_type: string; status: string }>
    >(result);

    assert.equal(payload.length, 2);
    assert.deepEqual(
      payload.map((page) => page.id).sort(),
      [first.id, second.id].sort()
    );
  } finally {
    repository.close();
    await server.close();
  }
});

test("wiki_read MCP tool returns page with backlinks", async () => {
  const { repository, pageManager, crossReferenceService, server } = createServerHarness();

  try {
    const target = pageManager.createPage({
      title: "WAL Runbook",
      content: "Enable WAL mode for SQLite writes.",
      summary: "WAL mode guide.",
      page_type: "runbook"
    });
    const source = pageManager.createPage({
      title: "SQLite Decisions",
      content: `Reference [[${target.slug}]] before changing SQLite pragmas.`,
      summary: "SQLite decision log.",
      page_type: "decision_log"
    });

    crossReferenceService.updateCrossReferences(source);

    const result = await getRegisteredTools(server).wiki_read.handler(
      {
        slug: target.slug
      },
      {}
    );
    const payload = parseToolPayload<{
      page: { id: string; slug: string };
      backlinks: Array<{ page_id: string; slug: string; context: string }>;
    }>(result);

    assert.equal(payload.page.id, target.id);
    assert.equal(payload.page.slug, target.slug);
    assert.equal(payload.backlinks.length, 1);
    assert.equal(payload.backlinks[0]?.page_id, source.id);
    assert.equal(payload.backlinks[0]?.slug, source.slug);
    assert.match(payload.backlinks[0]?.context ?? "", /\[\[wal-runbook\]\]/);
  } finally {
    repository.close();
    await server.close();
  }
});

test("wiki_review approve changes status to published", () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const crossReferenceService = new CrossReferenceService(pageManager);

  try {
    const page = pageManager.createPage({
      title: "Draft Wiki Page",
      content: "Needs review before publication.",
      summary: "Draft summary.",
      page_type: "topic"
    });

    const result = reviewWikiPage(
      pageManager,
      crossReferenceService,
      page.slug,
      "approve"
    );
    const updated = pageManager.getPage(page.id);

    assert.equal(result.page_id, page.id);
    assert.equal(result.new_status, "published");
    assert.ok(updated);
    assert.equal(updated.status, "published");
    assert.equal(updated.reviewed, true);
    assert.ok(updated.reviewed_at);
    assert.ok(updated.published_at);
  } finally {
    repository.close();
  }
});

test("wiki_search returns FTS results", () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);

  try {
    const expected = pageManager.createPage({
      title: "SQLite Tuning",
      content: "SQLite tuning covers WAL mode and cache pragmas.",
      summary: "WAL mode tuning guide.",
      page_type: "reference",
      project: "vega"
    });
    pageManager.createPage({
      title: "Redis Notes",
      content: "Redis settings for cache invalidation.",
      summary: "Redis guide.",
      page_type: "reference",
      project: "vega"
    });

    const results = searchWikiPages(repository, {
      query: "WAL",
      project: "vega",
      limit: 10
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, expected.id);
    assert.equal(results[0]?.slug, expected.slug);
  } finally {
    repository.close();
  }
});

test("deep_recall MCP tool returns cold archive results", async () => {
  const { repository, server } = createServerHarness();
  const archiveService = new ArchiveService(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-archive-1",
        type: "decision",
        title: "Backup decision",
        content: "Hot memory summary for backup validation."
      })
    );
    archiveService.store(
      "Full tool log with SQLite backup evidence and restore commands.",
      "tool_log",
      "vega",
      {
        source_memory_id: "memory-archive-1",
        title: "SQLite backup tool log",
        metadata: {
          tool: "backup"
        }
      }
    );

    const result = await getRegisteredTools(server).deep_recall.handler(
      {
        query: "restore commands",
        project: "vega",
        include_content: true,
        include_metadata: true
      },
      {}
    );
    const payload = parseToolPayload<{
      results: Array<{
        archive_id: string;
        memory_id: string | null;
        archive_type: string;
        content?: string;
        metadata?: Record<string, unknown>;
      }>;
      next_cursor: string | null;
      injected_into_session: boolean;
    }>(result);

    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0]?.memory_id, "memory-archive-1");
    assert.equal(payload.results[0]?.archive_type, "tool_log");
    assert.match(payload.results[0]?.content ?? "", /restore commands/);
    assert.deepEqual(payload.results[0]?.metadata, {
      tool: "backup"
    });
    assert.equal(payload.next_cursor, null);
    assert.equal(payload.injected_into_session, false);
  } finally {
    repository.close();
    await server.close();
  }
});

test("wiki_synthesize MCP tool returns synthesis result", async () => {
  const restoreFetch = installOllamaMock();
  const { repository, pageManager, server } = createServerHarness();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        title: "Auth setup",
        content: "Auth uses token refresh for wiki synthesis.",
        tags: ["auth"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-2",
        title: "Auth deploy",
        content: "Auth deploy requires a smoke test.",
        tags: ["auth"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-3",
        title: "Auth tests",
        content: "Auth tests found a stale session bug.",
        tags: ["auth"]
      })
    );

    const result = await getRegisteredTools(server).wiki_synthesize.handler(
      {
        topic: "auth",
        project: "vega",
        force: false
      },
      {}
    );
    const payload = parseToolPayload<{
      page_id: string;
      slug: string;
      action: string;
      memories_used: number;
    }>(result);
    const page = pageManager.getPage(payload.page_id);

    assert.equal(payload.action, "created");
    assert.equal(payload.slug, "auth");
    assert.equal(payload.memories_used, 3);
    assert.ok(page);
    assert.equal(page.slug, "auth");
  } finally {
    restoreFetch();
    repository.close();
    await server.close();
  }
});

test("wiki_publish MCP tool publishes a page to Obsidian", async () => {
  const { repository, pageManager, server } = createServerHarness();
  const vaultDir = mkdtempSync(join(tmpdir(), "vega-mcp-publish-"));
  const previousVault = process.env.VEGA_OBSIDIAN_VAULT;

  process.env.VEGA_OBSIDIAN_VAULT = vaultDir;

  try {
    const page = pageManager.createPage({
      title: "Published Wiki Topic",
      content: "Ship the wiki page to Obsidian.",
      summary: "Publish this page.",
      page_type: "topic"
    });

    pageManager.updatePage(
      page.id,
      {
        status: "published",
        reviewed: true,
        published_at: "2026-04-07T00:00:00.000Z"
      },
      "Seed published page"
    );

    const result = await getRegisteredTools(server).wiki_publish.handler(
      {
        slug: page.slug,
        target: "obsidian",
        all: false
      },
      {}
    );
    const payload = parseToolPayload<{
      published_count: number;
      target: string;
      errors: string[];
    }>(result);

    assert.equal(payload.published_count, 1);
    assert.equal(payload.target, "obsidian");
    assert.deepEqual(payload.errors, []);
    assert.equal(existsSync(join(vaultDir, "topics", "published-wiki-topic.md")), true);
  } finally {
    if (previousVault === undefined) {
      delete process.env.VEGA_OBSIDIAN_VAULT;
    } else {
      process.env.VEGA_OBSIDIAN_VAULT = previousVault;
    }

    rmSync(vaultDir, { recursive: true, force: true });
    repository.close();
    await server.close();
  }
});
