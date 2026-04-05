import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { DiagnoseService } from "../core/diagnose.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";

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
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  accessed_at: new Date().toISOString(),
  access_count: 0,
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const createHarness = () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-diagnose-"));
  const dataDir = join(tempDir, "data");
  const dbPath = join(dataDir, "memory.db");
  const config: VegaConfig = {
    dbPath,
    ollamaBaseUrl: "http://localhost:99999",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    backupRetentionDays: 7,
    apiPort: 3271,
    apiKey: undefined,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(tempDir, "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    observerEnabled: false,
  };
  const repository = new Repository(dbPath);
  const diagnoseService = new DiagnoseService(repository, config);

  return {
    config,
    repository,
    diagnoseService,
    cleanup(): void {
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
};

test("diagnose returns valid report structure", async () => {
  const harness = createHarness();

  try {
    harness.repository.createMemory(
      createMemory({
        id: "memory-sqlite",
        title: "SQLite startup failure",
        content: "SQLite issue during startup requires inspection."
      })
    );
    harness.repository.logPerformance({
      timestamp: new Date().toISOString(),
      operation: "memory_store",
      latency_ms: 42,
      memory_count: 1,
      result_count: 1
    });

    const report = await harness.diagnoseService.diagnose("SQLite startup");

    assert.equal(typeof report.report_path, "string");
    assert.equal(typeof report.summary, "string");
    assert.equal(Array.isArray(report.suggested_fixes), true);
    assert.equal(Array.isArray(report.issues_found), true);
    assert.equal(typeof report.handoff_prompt, "string");
    assert.equal(typeof report.can_auto_fix, "boolean");
    assert.match(report.summary, /Diagnose completed/);
    assert.match(report.handoff_prompt, /## Issue Description/);
  } finally {
    harness.cleanup();
  }
});

test("diagnose detects null embeddings", async () => {
  const harness = createHarness();

  try {
    harness.repository.createMemory(
      createMemory({
        id: "memory-null-embedding"
      })
    );

    const report = await harness.diagnoseService.diagnose();

    assert.equal(
      report.issues_found.some((issue) => issue.includes("null embeddings")),
      true
    );
  } finally {
    harness.cleanup();
  }
});

test("diagnose writes report file", async () => {
  const harness = createHarness();

  try {
    harness.repository.createMemory(
      createMemory({
        id: "memory-report",
        title: "Report Memory",
        embedding: Buffer.from([1, 2, 3])
      })
    );

    const report = await harness.diagnoseService.diagnose("report");

    assert.equal(existsSync(report.report_path), true);
    assert.match(readFileSync(report.report_path, "utf8"), /# Memory Diagnose Report/);
  } finally {
    harness.cleanup();
  }
});

test("diagnose sets can_auto_fix=true when only null embeddings are present", async () => {
  const harness = createHarness();
  const originalFetch = globalThis.fetch;
  const backupDir = join(dirname(harness.config.dbPath), "backups");

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ version: "mock" }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });

  try {
    harness.repository.createMemory(
      createMemory({
        id: "memory-auto-fix"
      })
    );
    harness.repository.logPerformance({
      timestamp: new Date().toISOString(),
      operation: "memory_store",
      latency_ms: 25,
      memory_count: 1,
      result_count: 1
    });
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      join(backupDir, `memory-${new Date().toISOString().slice(0, 10)}.db`),
      "backup",
      "utf8"
    );

    const report = await harness.diagnoseService.diagnose();

    assert.equal(report.can_auto_fix, true);
  } finally {
    globalThis.fetch = originalFetch;
    harness.cleanup();
  }
});
