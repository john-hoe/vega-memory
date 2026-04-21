import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { Repository } from "../db/repository.js";
import { applyRawInboxMigration, insertRawEvent } from "../ingestion/raw-inbox.js";
import { listReconciliationFindings } from "../reconciliation/findings-store.js";
import { dailyMaintenance } from "../scheduler/tasks.js";

const AUTO_ENABLED_ENV = "VEGA_RECONCILIATION_AUTO_ENABLED";

const createConfig = (dbPath: string, cacheDbPath: string): VegaConfig => ({
  dbPath,
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
  cacheDbPath,
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false
});

const createMemory = (createdAt: string): Parameters<Repository["createMemory"]>[0] => ({
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: null,
  type: "decision",
  project: "vega-memory",
  title: "Reconciliation test memory",
  content: "Reconciliation content",
  summary: "Summary",
  embedding: Buffer.from([1, 2, 3]),
  importance: 0.8,
  source: "explicit",
  tags: ["reconciliation"],
  created_at: createdAt,
  updated_at: createdAt,
  accessed_at: createdAt,
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega-memory"],
  source_context: null
});

const withEnv = async (
  key: string,
  value: string | undefined,
  run: () => Promise<void>
): Promise<void> => {
  const previous = process.env[key];

  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
};

const createHarness = () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-reconciliation-auto-"));
  const dataDir = join(tempDir, "data");
  const config = createConfig(join(dataDir, "memory.db"), join(tempDir, "cache.db"));
  const repository = new Repository(config.dbPath);
  const compactService = new CompactService(repository, config);
  const memoryService = new MemoryService(repository, config);

  return {
    tempDir,
    dataDir,
    config,
    repository,
    compactService,
    memoryService,
    close(): void {
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
};

const seedReconciliationWindow = (repository: Repository, createdAt: string): void => {
  applyRawInboxMigration(repository.db);
  repository.createMemory(createMemory(createdAt));
  insertRawEvent(repository.db, {
    schema_version: "1.0",
    event_id: "11111111-1111-4111-8111-111111111111",
    surface: "api",
    session_id: "session-1",
    thread_id: null,
    project: "vega-memory",
    cwd: null,
    host_timestamp: createdAt,
    role: "system",
    event_type: "decision",
    payload: {
      memory_type: "decision",
      title: "Reconciliation test memory",
      content: "Reconciliation content",
      summary: "Summary",
      tags: ["reconciliation"]
    },
    safety: {
      redacted: false,
      categories: []
    },
    artifacts: [],
    source_kind: "vega_memory"
  });
};

const countPersistedFindings = (repository: Repository): number => {
  const tableExists = repository.db
    .prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'reconciliation_findings'"
    )
    .get()
    ?.count ?? 0;

  if (tableExists === 0) {
    return 0;
  }

  return listReconciliationFindings(repository.db).length;
};

test("dailyMaintenance skips reconciliation when VEGA_RECONCILIATION_AUTO_ENABLED is false", async () => {
  const harness = createHarness();

  try {
    const fixedNow = Date.parse("2026-04-21T04:00:00.000Z");
    seedReconciliationWindow(
      harness.repository,
      new Date(fixedNow - 60 * 60 * 1000).toISOString()
    );

    await withEnv(AUTO_ENABLED_ENV, "false", async () => {
      await dailyMaintenance(
        harness.repository,
        harness.compactService,
        harness.memoryService,
        harness.config,
        {
          now: () => fixedNow,
          resolveEncryptionKey: async () => undefined
        }
      );
    });

    assert.equal(countPersistedFindings(harness.repository), 0);
  } finally {
    harness.close();
  }
});

test("dailyMaintenance runs reconciliation and persists findings when auto-trigger is enabled", async () => {
  const harness = createHarness();

  try {
    const fixedNow = Date.parse("2026-04-21T04:00:00.000Z");
    seedReconciliationWindow(
      harness.repository,
      new Date(fixedNow - 60 * 60 * 1000).toISOString()
    );

    await withEnv(AUTO_ENABLED_ENV, "true", async () => {
      await dailyMaintenance(
        harness.repository,
        harness.compactService,
        harness.memoryService,
        harness.config,
        {
          now: () => fixedNow,
          resolveEncryptionKey: async () => undefined
        }
      );
    });

    const findings = listReconciliationFindings(harness.repository.db);

    assert.equal(findings.length > 0, true);
    assert.deepEqual(
      [...new Set(findings.map((finding) => finding.dimension))].sort(),
      ["count", "ordering", "semantic", "shape"]
    );
  } finally {
    harness.close();
  }
});

test("dailyMaintenance logs reconciliation failures and continues when the auto-triggered run throws", async () => {
  const harness = createHarness();
  const originalConsoleError = console.error;
  const errors: string[] = [];

  console.error = (...args: unknown[]) => {
    errors.push(args.map((entry) => String(entry)).join(" "));
  };

  try {
    const fixedNow = Date.parse("2026-04-21T04:00:00.000Z");
    seedReconciliationWindow(
      harness.repository,
      new Date(fixedNow - 60 * 60 * 1000).toISOString()
    );

    await withEnv(AUTO_ENABLED_ENV, "true", async () => {
      await dailyMaintenance(
        harness.repository,
        harness.compactService,
        harness.memoryService,
        harness.config,
        {
          now: () => fixedNow,
          resolveEncryptionKey: async () => undefined,
          runReconciliation: async () => {
            throw new Error("forced reconciliation failure");
          }
        }
      );
    });

    assert.equal(
      errors.some((entry) => entry.includes("reconciliation_auto_trigger_failed")),
      true
    );
    assert.equal(
      existsSync(join(harness.dataDir, "snapshots")),
      true
    );
    assert.equal(
      readdirSync(join(harness.dataDir, "snapshots")).some((entry) =>
        /^snapshot-\d{4}-\d{2}-\d{2}\.md$/.test(entry)
      ),
      true
    );
  } finally {
    console.error = originalConsoleError;
    harness.close();
  }
});
