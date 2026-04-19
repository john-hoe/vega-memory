import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { embeddingCache } from "../embedding/cache.js";
import { SearchEngine } from "../search/engine.js";
import { shouldRunDaily, shouldRunWeekly, startSchedulerApiServer } from "../scheduler/index.js";
import { dailyMaintenance, refreshWikiProjection, weeklyHealthReport } from "../scheduler/tasks.js";
import { PageManager } from "../wiki/page-manager.js";

const createMemory = (overrides: Partial<Memory> = {}): Memory => {
  const { summary = null, ...rest } = overrides;

  return {
    id: "memory-1",
    type: "decision",
    project: "vega",
    title: "SQLite Decision",
    content: "Use SQLite for durable memory storage.",
    embedding: null,
    importance: 0.9,
    source: "explicit",
    tags: ["sqlite"],
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    accessed_at: "2026-04-01T00:00:00.000Z",
    access_count: 0,
    status: "active",
    verified: "verified",
    scope: "project",
    accessed_projects: ["vega"],
    ...rest,
    summary
  };
};

const installEmbeddingMock = (vector: number[]): (() => void) => {
  const originalFetch = globalThis.fetch;
  embeddingCache.clear();

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        embeddings: [vector]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );

  return () => {
    embeddingCache.clear();
    globalThis.fetch = originalFetch;
  };
};

const createSchedulerApiHarness = (apiKey?: string) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-scheduler-api-"));
  const config: VegaConfig = {
    dbPath: join(tempDir, "memory.db"),
    ollamaBaseUrl: "http://localhost:99999",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    shardingEnabled: false,
    backupRetentionDays: 7,
    apiPort: 0,
    apiKey,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(tempDir, "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    observerEnabled: false,
    dbEncryption: false
  };
  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(
    repository,
    memoryService,
    recallService,
    config
  );
  const compactService = new CompactService(repository, config);

  return {
    config,
    services: {
      repository,
      memoryService,
      recallService,
      sessionService,
      compactService
    },
    cleanup(): void {
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
};

test("scheduler does not start the HTTP API when apiKey is undefined", async () => {
  const harness = createSchedulerApiHarness();
  const messages: string[] = [];

  try {
    const runtime = await startSchedulerApiServer(
      harness.services,
      harness.config,
      (message) => messages.push(message)
    );

    assert.equal(runtime, null);
    assert.deepEqual(messages, [
      "HTTP API disabled: VEGA_API_KEY not configured. Set VEGA_API_KEY to enable remote access."
    ]);
  } finally {
    harness.cleanup();
  }
});

test("scheduler starts the HTTP API when apiKey is configured", async () => {
  const harness = createSchedulerApiHarness("top-secret");

  try {
    const runtime = await startSchedulerApiServer(harness.services, harness.config);

    assert.ok(runtime);

    const response = await fetch(`http://127.0.0.1:${runtime.apiPort}/api/health`, {
      headers: {
        authorization: "Bearer top-secret"
      }
    });

    assert.equal(response.status, 200);

    await runtime.apiServer.stop();
  } finally {
    harness.cleanup();
  }
});

test("shouldRunDaily only triggers once during the scheduled hour", () => {
  const scheduledTime = new Date("2026-04-06T04:10:00");

  assert.equal(shouldRunDaily(scheduledTime, null), true);
  assert.equal(shouldRunDaily(scheduledTime, Date.parse("2026-04-06T04:00:00")), false);
  assert.equal(shouldRunDaily(new Date("2026-04-06T03:59:00"), null), false);
});

test("shouldRunWeekly only triggers on Sunday at 03:00 once per week", () => {
  const sundayRun = new Date("2026-04-05T03:15:00");

  assert.equal(shouldRunWeekly(sundayRun, null), true);
  assert.equal(shouldRunWeekly(sundayRun, Date.parse("2026-04-05T03:00:00")), false);
  assert.equal(shouldRunWeekly(sundayRun, Date.parse("2026-03-29T03:00:00")), true);
  assert.equal(shouldRunWeekly(new Date("2026-04-06T03:15:00"), null), false);
});

test("dailyMaintenance creates backups, rebuilds embeddings, and exports a snapshot", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-scheduler-daily-"));
  const dataDir = join(tempDir, "data");
  const dbPath = join(dataDir, "memory.db");
  const backupDir = join(dataDir, "backups");
  const restoreFetch = installEmbeddingMock([0.25, 0.75]);
  const config: VegaConfig = {
    dbPath,
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "bge-m3",
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
    observerEnabled: false,
    dbEncryption: false
  };
  const repository = new Repository(dbPath);
  const compactService = new CompactService(repository, config);
  const memoryService = new MemoryService(repository, config);

  try {
    repository.createMemory(createMemory());
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "memory-2000-01-01.db"), "stale", "utf8");
    utimesSync(join(backupDir, "memory-2000-01-01.db"), new Date("2000-01-01"), new Date("2000-01-01"));

    await dailyMaintenance(repository, compactService, memoryService, config, {
      resolveEncryptionKey: async () => undefined
    });

    const stored = repository.getMemory("memory-1");
    const snapshotPath = join(dataDir, "snapshots", `snapshot-${new Date().toISOString().slice(0, 10)}.md`);
    const backups = readdirSync(backupDir);

    assert.ok(stored);
    assert.notEqual(stored.embedding, null);
    assert.equal(existsSync(snapshotPath), true);
    assert.equal(backups.includes("memory-2000-01-01.db"), false);
    assert.ok(backups.some((entry) => /^memory-\d{4}-\d{2}-\d{2}\.db$/.test(entry)));
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("dailyMaintenance polls RSS feeds, synthesizes wiki pages, and marks stale pages", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-scheduler-wiki-"));
  const dataDir = join(tempDir, "data");
  const dbPath = join(dataDir, "memory.db");
  const config: VegaConfig = {
    dbPath,
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "bge-m3",
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
    observerEnabled: false,
    dbEncryption: false
  };
  const repository = new Repository(dbPath);
  const compactService = new CompactService(repository, config);
  const memoryService = new MemoryService(repository, config);
  const pageManager = new PageManager(repository);
  const page = pageManager.createPage({
    title: "Scheduler Wiki Page",
    content: "Generated from scheduler tasks.",
    summary: "Scheduler wiki page.",
    page_type: "topic"
  });
  const publishedPage = pageManager.updatePage(
    page.id,
    {
      status: "published",
      reviewed: true,
      published_at: "2026-04-07T00:00:00.000Z"
    },
    "Seed published page"
  );
  let polledFeedCount = 0;
  let synthesizedUpdates = 0;
  const staleMarks: string[] = [];

  try {
    await dailyMaintenance(repository, compactService, memoryService, config, {
      resolveEncryptionKey: async () => undefined,
      rssService: {
        listFeeds: () => [
          {
            id: "feed-1",
            url: "https://example.com/feed.xml",
            title: "Example Feed",
            project: "vega",
            last_polled_at: null,
            last_entry_at: null,
            active: true,
            created_at: "2026-04-07T00:00:00.000Z"
          }
        ],
        pollFeed: async () => {
          polledFeedCount += 1;
          return 2;
        }
      } as unknown as NonNullable<Parameters<typeof dailyMaintenance>[4]>["rssService"],
      contentFetcher:
        {} as unknown as NonNullable<Parameters<typeof dailyMaintenance>[4]>["contentFetcher"],
      contentDistiller:
        {} as unknown as NonNullable<Parameters<typeof dailyMaintenance>[4]>["contentDistiller"],
      pageManager,
      synthesisEngine: {
        synthesizeAll: async () => [
          {
            page_id: publishedPage.id,
            slug: publishedPage.slug,
            action: "created",
            memories_used: 3
          }
        ]
      } as unknown as NonNullable<Parameters<typeof dailyMaintenance>[4]>["synthesisEngine"],
      crossReferenceService: {
        updateCrossReferences: () => {
          synthesizedUpdates += 1;
        }
      } as unknown as NonNullable<Parameters<typeof dailyMaintenance>[4]>["crossReferenceService"],
      stalenessService: {
        detectStalePages: () => [pageManager.getPage(publishedPage.id) ?? publishedPage],
        markStale: (pageId: string) => {
          staleMarks.push(pageId);
        }
      } as unknown as NonNullable<Parameters<typeof dailyMaintenance>[4]>["stalenessService"]
    });

    assert.equal(polledFeedCount, 1);
    assert.equal(synthesizedUpdates, 1);
    assert.deepEqual(staleMarks, [publishedPage.id]);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("refreshWikiProjection backfills legacy pages without spaces before synthesis", async () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  let crossReferenceUpdates = 0;

  try {
    repository.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          number,
          number,
          number,
          string,
          string
        ]
      >(
        `INSERT INTO wiki_pages (
           id, slug, title, content, summary, page_type, scope, tags, source_memory_ids,
           auto_generated, reviewed, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "legacy-page",
        "legacy-page",
        "Legacy Page",
        "Legacy content",
        "Legacy summary",
        "runbook",
        "project",
        "[]",
        "[]",
        1,
        0,
        1,
        "2026-04-08T00:00:00.000Z",
        "2026-04-08T00:00:00.000Z"
      );

    const result = await refreshWikiProjection(
      pageManager,
      {
        synthesizeAll: async () => [
          {
            page_id: "legacy-page",
            slug: "legacy-page",
            action: "created",
            memories_used: 3
          }
        ]
      } as Parameters<typeof refreshWikiProjection>[1],
      {
        updateCrossReferences: () => {
          crossReferenceUpdates += 1;
        }
      } as unknown as Parameters<typeof refreshWikiProjection>[2]
    );

    const page = pageManager.getPage("legacy-page");

    assert.equal(result.spaces_backfilled, 1);
    assert.equal(result.synthesized, 1);
    assert.equal(crossReferenceUpdates, 1);
    assert.notEqual(page?.space_id, null);
    assert.equal(repository.listWikiSpaces(null).length, 1);
  } finally {
    repository.close();
  }
});

test("dailyMaintenance encrypts backups when resolveEncryptionKey provides a key", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-scheduler-daily-encrypted-"));
  const dataDir = join(tempDir, "data");
  const dbPath = join(dataDir, "memory.db");
  const backupDir = join(dataDir, "backups");
  const restoreFetch = installEmbeddingMock([0.25, 0.75]);
  const config: VegaConfig = {
    dbPath,
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "bge-m3",
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
    observerEnabled: false,
    dbEncryption: false
  };
  const repository = new Repository(dbPath);
  const compactService = new CompactService(repository, config);
  const memoryService = new MemoryService(repository, config);
  const encryptionKey =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

  try {
    repository.createMemory(createMemory());
    mkdirSync(backupDir, { recursive: true });

    await dailyMaintenance(repository, compactService, memoryService, config, {
      resolveEncryptionKey: async () => encryptionKey
    });

    assert.ok(readdirSync(backupDir).some((entry) => entry.endsWith(".db.enc")));
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("weeklyHealthReport writes integrity and memory count details", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-scheduler-weekly-"));
  const dataDir = join(tempDir, "data");
  const dbPath = join(dataDir, "memory.db");
  const config: VegaConfig = {
    dbPath,
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "bge-m3",
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
    observerEnabled: false,
    dbEncryption: false
  };
  const repository = new Repository(dbPath);

  try {
    const recentCreatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    repository.createMemory(
      createMemory({
        id: "decision-active",
        type: "decision",
        created_at: recentCreatedAt,
        updated_at: recentCreatedAt,
        status: "active",
        verified: "unverified",
        accessed_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
      })
    );
    repository.createMemory(
      createMemory({
        id: "insight-archived",
        type: "insight",
        title: "Archived Insight",
        created_at: recentCreatedAt,
        updated_at: recentCreatedAt,
        status: "archived",
        embedding: Buffer.from([1, 2, 3]),
        accessed_at: new Date().toISOString()
      })
    );
    repository.updateMemory(
      "decision-active",
      {
        access_count: 3
      },
      {
        skipVersion: true
      }
    );
    repository.updateMemory(
      "insight-archived",
      {
        access_count: 8
      },
      {
        skipVersion: true
      }
    );
    repository.logPerformance({
      timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      operation: "memory_store",
      latency_ms: 80,
      memory_count: 1,
      result_count: 1
    });
    repository.logPerformance({
      timestamp: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      operation: "memory_recall",
      latency_ms: 120,
      memory_count: 2,
      result_count: 1
    });
    repository.logPerformance({
      timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      operation: "memory_list",
      latency_ms: 400,
      memory_count: 2,
      result_count: 2
    });

    await weeklyHealthReport(repository, config);

    const reportPath = join(dataDir, "reports", `weekly-${new Date().toISOString().slice(0, 10)}.md`);
    const report = readFileSync(reportPath, "utf8");

    assert.equal(existsSync(reportPath), true);
    assert.match(report, /Result: ok/);
    assert.match(report, /Total memories: 2/);
    assert.match(report, /Not accessed in 30\+ days: 1/);
    assert.match(report, /Average latency over past 7 days: 100\.00 ms/);
    assert.match(report, /Accessed in last 30 days: 50\.0% \(1\/2\)/);
    assert.match(report, /Unverified: 50\.0% \(1\/2\)/);
    assert.match(report, /Archived: 50\.0% \(1\/2\)/);
    assert.match(report, /New memories this week: 2/);
    assert.match(report, /Total active: 1/);
    assert.match(report, /Total archived: 1/);
    assert.match(report, /\| 1 \| insight-archived \| Archived Insight \| 8 \|/);
    assert.match(report, /\| decision \| 1 \|/);
    assert.match(report, /\| insight \| 1 \|/);
    assert.match(report, /\| active \| 1 \|/);
    assert.match(report, /\| archived \| 1 \|/);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
