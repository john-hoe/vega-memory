import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";
import { ContradictionDetector } from "../wiki/contradiction.js";
import { PageManager } from "../wiki/page-manager.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  dbEncryption: false,
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "test-chat-model",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false
};

const installOllamaMock = (
  chatResponses: string[] = ["CONSISTENT No contradiction found."]
): (() => void) => {
  const originalFetch = globalThis.fetch;
  let chatIndex = 0;

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/api/chat")) {
      const content = chatResponses[Math.min(chatIndex, chatResponses.length - 1)] ?? chatResponses[0];
      chatIndex += 1;

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

    if (url.includes("/api/version")) {
      return new Response(
        JSON.stringify({
          version: "test"
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

const createHarness = (withPageManager = true) => {
  const repository = new Repository(":memory:");
  const pageManager = withPageManager ? new PageManager(repository) : undefined;
  const memoryService = new MemoryService(repository, baseConfig);
  const recallService = new RecallService(repository, new SearchEngine(repository, baseConfig), baseConfig);
  const sessionService = new SessionService(
    repository,
    memoryService,
    recallService,
    baseConfig,
    pageManager
  );

  return {
    repository,
    pageManager,
    sessionService
  };
};

const publishPage = (
  pageManager: PageManager,
  params: Parameters<PageManager["createPage"]>[0]
) => {
  const page = pageManager.createPage(params);

  return pageManager.updatePage(
    page.id,
    {
      status: "published",
      published_at: "2026-04-06T00:00:00.000Z"
    },
    "Publish test page"
  );
};

test("extractKeyClaims extracts technical sentences", () => {
  const { repository, pageManager } = createHarness();
  const detector = new ContradictionDetector(pageManager as PageManager, repository, baseConfig);

  try {
    const claims = detector.extractKeyClaims(`
      Intro text for the wiki.
      Use better-sqlite3 for SQLite access.
      The team felt good about the migration.
      Run \`npm run build\` before release.
      Docs live in src/core/session.ts.
      Version 2.1.0 is required for deployment.
    `);

    assert.deepEqual(claims, [
      "Use better-sqlite3 for SQLite access.",
      "Run `npm run build` before release.",
      "Docs live in src/core/session.ts.",
      "Version 2.1.0 is required for deployment."
    ]);
  } finally {
    repository.close();
  }
});

test("detectContradictions finds conflicting pages", async () => {
  const restoreFetch = installOllamaMock([
    "CONTRADICTION The two pages disagree about the SQLite library."
  ]);
  const { repository, pageManager } = createHarness();
  const detector = new ContradictionDetector(pageManager as PageManager, repository, baseConfig);

  try {
    const pageA = publishPage(pageManager as PageManager, {
      title: "SQLite Runbook",
      content: "Use better-sqlite3 for SQLite access in src/db/repository.ts.",
      summary: "SQLite runbook.",
      page_type: "runbook",
      project: "vega",
      tags: ["sqlite", "database"]
    });
    const pageB = publishPage(pageManager as PageManager, {
      title: "SQLite Migration Notes",
      content: "Don't use better-sqlite3 for SQLite access in src/db/repository.ts.",
      summary: "SQLite migration notes.",
      page_type: "decision_log",
      project: "vega",
      tags: ["sqlite", "migration"]
    });

    const contradictions = await detector.detectContradictions("vega");

    assert.equal(contradictions.length, 1);
    assert.deepEqual(
      [contradictions[0]?.page_a_id, contradictions[0]?.page_b_id].sort(),
      [pageA.id, pageB.id].sort()
    );
    assert.equal(contradictions[0]?.resolved, false);
    const statements = [
      contradictions[0]?.statement_a ?? "",
      contradictions[0]?.statement_b ?? ""
    ];

    assert.equal(statements.some((statement) => /Use better-sqlite3/i.test(statement)), true);
    assert.equal(
      statements.some((statement) => /Don't use better-sqlite3/i.test(statement)),
      true
    );
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("resolveContradiction marks as resolved", () => {
  const { repository, pageManager } = createHarness();
  const detector = new ContradictionDetector(pageManager as PageManager, repository, baseConfig);
  const pageA = publishPage(pageManager as PageManager, {
    title: "Auth Decision",
    content: "Use token refresh.",
    summary: "Auth decision.",
    page_type: "decision_log",
    project: "vega",
    tags: ["auth"]
  });
  const pageB = publishPage(pageManager as PageManager, {
    title: "Auth Runbook",
    content: "Avoid token refresh.",
    summary: "Auth runbook.",
    page_type: "runbook",
    project: "vega",
    tags: ["auth"]
  });
  const contradictionId = "contradiction-1";

  try {
    repository.db
      .prepare<[string, string, string, string, string, string, number]>(
        `INSERT INTO wiki_contradictions (
           id, page_a_id, page_b_id, statement_a, statement_b, detected_at, resolved
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        contradictionId,
        pageA.id,
        pageB.id,
        "Use token refresh.",
        "Avoid token refresh.",
        "2026-04-06T00:00:00.000Z",
        0
      );

    detector.resolveContradiction(contradictionId);

    const row = repository.db
      .prepare<[string], { resolved: number }>(
        "SELECT resolved FROM wiki_contradictions WHERE id = ?"
      )
      .get(contradictionId);

    assert.equal(row?.resolved, 1);
    assert.deepEqual(detector.getContradictions("vega"), []);
  } finally {
    repository.close();
  }
});

test("sessionStart returns relevant wiki pages", async () => {
  const restoreFetch = installOllamaMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-wiki-session-start-"));
  const project = basename(tempDir);
  const { repository, pageManager, sessionService } = createHarness();

  try {
    const matching = publishPage(pageManager as PageManager, {
      title: "SQLite Build Runbook",
      content: "Run `npm run build` before SQLite deploys.",
      summary: "Build steps for SQLite work.",
      page_type: "runbook",
      project,
      tags: ["sqlite", "build"]
    });
    publishPage(pageManager as PageManager, {
      title: "Unrelated Auth Guide",
      content: "Use token refresh in auth flows.",
      summary: "Auth guide.",
      page_type: "reference",
      project,
      tags: ["auth"]
    });

    const result = await sessionService.sessionStart(tempDir, "sqlite build");

    assert.equal(result.relevant_wiki_pages.length, 1);
    assert.deepEqual(result.relevant_wiki_pages[0], {
      slug: matching.slug,
      title: matching.title,
      summary: matching.summary,
      page_type: matching.page_type
    });
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart returns wiki_drafts_pending count", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-wiki-session-drafts-"));
  const project = basename(tempDir);
  const { repository, pageManager, sessionService } = createHarness();

  try {
    (pageManager as PageManager).createPage({
      title: "Draft Runbook",
      content: "Use SQLite for local storage.",
      summary: "Draft runbook.",
      page_type: "runbook",
      project,
      tags: ["sqlite"]
    });
    (pageManager as PageManager).createPage({
      title: "Draft Decision",
      content: "Prefer commander.js for CLI parsing.",
      summary: "Draft decision.",
      page_type: "decision_log",
      project,
      tags: ["cli"]
    });

    const result = await sessionService.sessionStart(tempDir);

    assert.equal(result.wiki_drafts_pending, 2);
    assert.deepEqual(result.relevant_wiki_pages, []);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart works without PageManager", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-wiki-session-no-page-manager-"));
  const { repository, sessionService } = createHarness(false);

  try {
    const result = await sessionService.sessionStart(tempDir);

    assert.deepEqual(result.relevant_wiki_pages, []);
    assert.equal(result.wiki_drafts_pending, 0);
    assert.ok(Array.isArray(result.active_tasks));
    assert.ok(Array.isArray(result.preferences));
    assert.ok(Array.isArray(result.context));
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
