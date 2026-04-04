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
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
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
    repository.createMemory(
      createMemory({
        id: "decision-active",
        type: "decision",
        status: "active",
        accessed_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
      })
    );
    repository.createMemory(
      createMemory({
        id: "insight-archived",
        type: "insight",
        status: "archived",
        embedding: Buffer.from([1, 2, 3]),
        accessed_at: new Date().toISOString()
      })
    );

    await weeklyHealthReport(repository, config);

    const reportPath = join(dataDir, "reports", `weekly-${new Date().toISOString().slice(0, 10)}.md`);
    const report = readFileSync(reportPath, "utf8");

    assert.equal(existsSync(reportPath), true);
    assert.match(report, /Result: ok/);
    assert.match(report, /Total memories: 2/);
    assert.match(report, /Not accessed in 30\+ days: 1/);
    assert.match(report, /\| decision \| 1 \|/);
    assert.match(report, /\| insight \| 1 \|/);
    assert.match(report, /\| active \| 1 \|/);
    assert.match(report, /\| archived \| 1 \|/);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
