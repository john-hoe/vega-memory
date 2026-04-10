import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { ConsolidationCron } from "../core/consolidation-cron.js";
import { ConsolidationScheduler } from "../core/consolidation-scheduler.js";
import type { FactClaim, Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  dbEncryption: false,
  consolidationCronEnabled: true,
  consolidationCronIntervalMs: 20,
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

const now = "2026-04-10T00:00:00.000Z";

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  tenant_id: null,
  type: "insight",
  project: "vega",
  title: "Consolidation memory",
  content: "Consolidation input for cron tests.",
  summary: null,
  embedding: null,
  importance: 0.8,
  source: "explicit",
  tags: ["cron"],
  created_at: now,
  updated_at: now,
  accessed_at: now,
  status: "active",
  verified: "unverified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const createFactClaim = (overrides: Partial<FactClaim> = {}): FactClaim => ({
  id: "fact-1",
  tenant_id: null,
  project: "vega",
  source_memory_id: "memory-1",
  evidence_archive_id: null,
  canonical_key: "vega-memory|database|sqlite",
  subject: "vega-memory",
  predicate: "database",
  claim_value: "sqlite",
  claim_text: "Vega Memory uses SQLite.",
  source: "hot_memory",
  status: "active",
  confidence: 0.8,
  valid_from: "2026-04-01T00:00:00.000Z",
  valid_to: null,
  temporal_precision: "day",
  invalidation_reason: null,
  created_at: now,
  updated_at: now,
  ...overrides
});

const waitFor = async (predicate: () => boolean, timeoutMs = 750): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await delay(10);
  }

  assert.fail("Timed out waiting for consolidation cron");
};

test("ConsolidationCron starts and stops cleanly", async () => {
  const repository = new Repository(":memory:");
  const cron = new ConsolidationCron(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true
    }
  });

  try {
    repository.createMemory(createStoredMemory());

    cron.start(20);
    cron.stop();
    cron.stop();

    await delay(80);

    assert.equal(repository.getLastConsolidationRun("vega"), null);
  } finally {
    cron.stop();
    repository.close();
  }
});

test("ConsolidationCron runs consolidation for all projects", async () => {
  const tempDir = join(tmpdir(), `vega-consolidation-cron-${Date.now()}`);
  const repository = new Repository(":memory:");
  const cron = new ConsolidationCron(repository, {
    ...baseConfig,
    dbPath: join(tempDir, "memory.db"),
    features: {
      consolidationReport: true
    }
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "alpha-memory",
        project: "alpha",
        accessed_projects: ["alpha"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "beta-memory",
        project: "beta",
        accessed_projects: ["beta"]
      })
    );

    cron.start(20);

    await waitFor(
      () =>
        repository.getLastConsolidationRun("alpha") !== null &&
        repository.getLastConsolidationRun("beta") !== null
    );

    const reportDir = join(tempDir, "consolidation-reports");
    assert.equal(existsSync(reportDir), true);
  } finally {
    cron.stop();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ConsolidationCron skips when feature disabled", async () => {
  const repository = new Repository(":memory:");
  const cron = new ConsolidationCron(repository, {
    ...baseConfig,
    features: {
      consolidationReport: false
    }
  });

  try {
    repository.createMemory(createStoredMemory());

    cron.start(20);
    await delay(80);

    assert.equal(repository.getLastConsolidationRun("vega"), null);
  } finally {
    cron.stop();
    repository.close();
  }
});

test("ConsolidationCron handles per-project errors gracefully", async () => {
  const repository = new Repository(":memory:");
  const errors: string[] = [];
  const originalRun = ConsolidationScheduler.prototype.run;
  const originalConsoleError = console.error;
  const cron = new ConsolidationCron(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true
    }
  });

  ConsolidationScheduler.prototype.run = function (
    project: string,
    tenantId?: string | null,
    policy?: Parameters<ConsolidationScheduler["run"]>[2]
  ) {
    if (project === "broken") {
      throw new Error("forced failure");
    }

    return originalRun.call(this, project, tenantId, policy);
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    repository.createMemory(
      createStoredMemory({
        id: "healthy-memory",
        project: "healthy",
        accessed_projects: ["healthy"]
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "healthy-claim",
        project: "healthy",
        source_memory_id: "healthy-memory",
        valid_to: "2026-04-01T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "broken-memory",
        project: "broken",
        accessed_projects: ["broken"]
      })
    );

    cron.start(20);

    await waitFor(() => repository.getLastConsolidationRun("healthy") !== null);

    assert.notEqual(repository.getLastConsolidationRun("healthy"), null);
    assert.equal(repository.getLastConsolidationRun("broken"), null);
    assert.equal(errors.some((entry) => entry.includes("[consolidation-cron] broken: forced failure")), true);
  } finally {
    cron.stop();
    ConsolidationScheduler.prototype.run = originalRun;
    console.error = originalConsoleError;
    repository.close();
  }
});
