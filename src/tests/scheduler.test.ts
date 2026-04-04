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
import { SearchEngine } from "../search/engine.js";
import { startSchedulerApiServer } from "../scheduler/index.js";
import { dailyMaintenance, weeklyHealthReport } from "../scheduler/tasks.js";

const createMemory = (overrides: Partial<Memory> = {}): Memory => ({
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
  ...overrides
});

const installEmbeddingMock = (vector: number[]): (() => void) => {
  const originalFetch = globalThis.fetch;

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
    backupRetentionDays: 7,
    apiPort: 0,
    apiKey,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(tempDir, "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined
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
    backupRetentionDays: 7,
    apiPort: 3271,
    apiKey: undefined,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: "./data/cache.db",
    telegramBotToken: undefined,
    telegramChatId: undefined
  };
  const repository = new Repository(dbPath);
  const compactService = new CompactService(repository, config);

  try {
    repository.createMemory(createMemory());
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "memory-2000-01-01.db"), "stale", "utf8");
    utimesSync(join(backupDir, "memory-2000-01-01.db"), new Date("2000-01-01"), new Date("2000-01-01"));

    await dailyMaintenance(repository, compactService, config);

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
    backupRetentionDays: 7,
    apiPort: 3271,
    apiKey: undefined,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: "./data/cache.db",
    telegramBotToken: undefined,
    telegramChatId: undefined
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
