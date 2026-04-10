import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { ConsolidationScheduler } from "../core/consolidation-scheduler.js";
import type { ConsolidationReport, FactClaim, Memory } from "../core/types.js";
import { CONSOLIDATION_CANDIDATE_KINDS } from "../core/types.js";
import { Repository } from "../db/repository.js";

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

const now = "2026-04-10T00:00:00.000Z";

const createEmbeddingBuffer = (values: number[]): Buffer =>
  Buffer.from(new Float32Array(values).buffer);

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  tenant_id: null,
  type: "insight",
  project: "vega",
  title: "Auth memory",
  content: "Auth configuration changed for the consolidation pipeline.",
  summary: null,
  embedding: null,
  importance: 0.8,
  source: "explicit",
  tags: ["auth"],
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

const readStoredReport = (repository: Repository, runId: string): ConsolidationReport => {
  const row = repository.db
    .prepare<[string], { report_json: string | null }>(
      "SELECT report_json FROM consolidation_runs WHERE run_id = ?"
    )
    .get(runId);

  return JSON.parse(row?.report_json ?? "{}") as ConsolidationReport;
};

test("dry-run mode produces report without executing", () => {
  const repository = new Repository(":memory:");
  const scheduler = new ConsolidationScheduler(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      consolidationAutoExecute: true,
      factClaims: true
    }
  });

  try {
    repository.createMemory(createStoredMemory());
    repository.createFactClaim(
      createFactClaim({
        valid_to: "2026-04-01T00:00:00.000Z"
      })
    );

    const run = scheduler.run("vega", null, { mode: "dry_run" });

    assert.equal(run.total_candidates, 1);
    assert.equal(run.actions_executed, 0);
    assert.equal(repository.getFactClaim("fact-1")?.status, "active");
  } finally {
    repository.close();
  }
});

test("auto-low-risk mode executes safe actions", () => {
  const repository = new Repository(":memory:");
  const scheduler = new ConsolidationScheduler(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      consolidationAutoExecute: true,
      factClaims: true
    }
  });

  try {
    repository.createMemory(createStoredMemory());
    repository.createFactClaim(
      createFactClaim({
        valid_to: "2026-04-01T00:00:00.000Z"
      })
    );

    const run = scheduler.run("vega", null, { mode: "auto_low_risk" });

    assert.equal(run.actions_executed, 1);
    assert.equal(repository.getFactClaim("fact-1")?.status, "suspected_expired");
  } finally {
    repository.close();
  }
});

test("high-risk candidates are always skipped", () => {
  const repository = new Repository(":memory:");
  const scheduler = new ConsolidationScheduler(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      consolidationAutoExecute: true,
      factClaims: true
    }
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "conflict-memory",
        verified: "conflict"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "conflict-claim",
        source_memory_id: "conflict-memory"
      })
    );

    const run = scheduler.run("vega", null, { mode: "auto_low_risk" });

    assert.equal(run.total_candidates, 1);
    assert.equal(run.actions_executed, 0);
    assert.equal(run.actions_skipped, 1);
    assert.equal(repository.getFactClaim("conflict-claim")?.status, "active");
  } finally {
    repository.close();
  }
});

test("policy filters detectors", () => {
  const repository = new Repository(":memory:");
  const scheduler = new ConsolidationScheduler(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      consolidationAutoExecute: false,
      factClaims: true
    }
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "dup-1",
        title: "Auth cache decision",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.4])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "dup-2",
        title: "Auth cache design",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.41])
      })
    );

    const run = scheduler.run("vega", null, {
      enabled_detectors: ["duplicate_merge"]
    });
    const report = readStoredReport(repository, run.run_id);

    assert.deepEqual(
      report.sections.map((section) => section.kind),
      ["duplicate_merge"]
    );
    assert.equal(report.sections[0]?.candidates.length, 1);
  } finally {
    repository.close();
  }
});

test("default policy is sensible", () => {
  const repository = new Repository(":memory:");
  const scheduler = new ConsolidationScheduler(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true
    }
  });

  try {
    const policy = scheduler.getDefaultPolicy();

    assert.equal(policy.mode, "dry_run");
    assert.deepEqual(policy.enabled_detectors, [...CONSOLIDATION_CANDIDATE_KINDS]);
    assert.deepEqual(policy.auto_actions, []);
    assert.equal(policy.trigger, "manual");
  } finally {
    repository.close();
  }
});
