import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { ArchiveService } from "../core/archive-service.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";
import { escapeFtsMatchQuery } from "../db/fts-query-escape.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  dbEncryption: false,
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
  features: {
    deepRecall: true
  }
};

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "task-batch-25a",
  type: "task_state",
  project: "vega",
  title: "Batch 25a completed",
  content: "Completed Batch 25a with deep recall evidence.",
  summary: null,
  embedding: null,
  importance: 0.9,
  source: "explicit",
  tags: ["batch-25a", "completed"],
  created_at: "2026-04-21T00:00:00.000Z",
  updated_at: "2026-04-21T00:00:00.000Z",
  accessed_at: "2026-04-21T00:00:00.000Z",
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const createSessionService = (config: VegaConfig = baseConfig) => {
  const repository = new Repository(config.dbPath);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, new SearchEngine(repository, config), config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);

  return {
    repository,
    sessionService
  };
};

test("escapeFtsMatchQuery quotes mixed alphanumeric tokens used by L3 deep recall", () => {
  assert.equal(
    escapeFtsMatchQuery("Batch 25a completed"),
    "\"Batch\" OR \"25a\" OR \"completed\""
  );
});

test("sessionStart L3 does not throw when active task titles contain mixed alphanumeric tokens", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-start-l3-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService();
  const archiveService = new ArchiveService(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        project,
        content: "Completed Batch 25a with recall evidence",
        tags: []
      })
    );
    archiveService.store(
      "Full batch 25a evidence with restore commands.",
      "tool_log",
      project,
      {
        source_memory_id: "task-batch-25a",
        title: "Batch 25a evidence"
      }
    );

    const result = await sessionService.sessionStart(tempDir, undefined, undefined, "L3");

    assert.equal(result.project, project);
    assert.ok(result.deep_recall);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
