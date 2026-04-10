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

test("dry_run mode does not create approval items", () => {
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
    assert.equal(repository.listApprovalItems("vega").length, 0);
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

test("auto_low_risk mode submits medium/high risk candidates to approval queue", () => {
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
        id: "low-memory",
        title: "Low risk memory"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "low-claim",
        source_memory_id: "low-memory",
        subject: "vega-low",
        predicate: "status",
        valid_to: "2026-04-01T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "dup-1",
        title: "Alpha memo",
        embedding: createEmbeddingBuffer([1, 0, 0, 0])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "dup-2",
        title: "Beta note",
        embedding: createEmbeddingBuffer([0.86, 0.51, 0, 0])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "conflict-memory",
        verified: "conflict"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "conflict-claim",
        source_memory_id: "conflict-memory",
        subject: "vega-conflict",
        predicate: "database"
      })
    );

    scheduler.run("vega", null, { mode: "auto_low_risk" });

    const pending = repository.listApprovalItems("vega");

    assert.equal(pending.length, 2);
    assert.deepEqual(
      pending.map((item) => item.candidate_risk).sort(),
      ["high", "medium"]
    );
    assert.equal(repository.getFactClaim("low-claim")?.status, "suspected_expired");
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

test("same input produces same run key", () => {
  const repository = new Repository(":memory:");
  const scheduler = new ConsolidationScheduler(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      consolidationAutoExecute: true
    }
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "dup-1",
        title: "Alpha memo",
        embedding: createEmbeddingBuffer([1, 0, 0, 0])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "dup-2",
        title: "Beta note",
        embedding: createEmbeddingBuffer([0.86, 0.51, 0, 0])
      })
    );

    const first = scheduler.run("vega", null, { mode: "auto_low_risk" });
    const second = scheduler.run("vega", null, { mode: "auto_low_risk" });

    assert.equal(first.run_id, second.run_id);
    assert.equal(repository.listApprovalItems("vega").length, 1);
    assert.match(second.errors.at(-1) ?? "", /deduplicated/i);
  } finally {
    repository.close();
  }
});

test("different input produces different run key", () => {
  const repository = new Repository(":memory:");
  const scheduler = new ConsolidationScheduler(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      consolidationAutoExecute: true
    }
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "vega-dup-1",
        project: "vega",
        accessed_projects: ["vega"],
        title: "Alpha memo",
        embedding: createEmbeddingBuffer([1, 0, 0, 0])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "vega-dup-2",
        project: "vega",
        accessed_projects: ["vega"],
        title: "Beta note",
        embedding: createEmbeddingBuffer([0.86, 0.51, 0, 0])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "atlas-dup-1",
        project: "atlas",
        accessed_projects: ["atlas"],
        title: "Gamma memo",
        embedding: createEmbeddingBuffer([1, 0, 0, 0])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "atlas-dup-2",
        project: "atlas",
        accessed_projects: ["atlas"],
        title: "Delta note",
        embedding: createEmbeddingBuffer([0.86, 0.51, 0, 0])
      })
    );

    const vegaRun = scheduler.run("vega", null, { mode: "auto_low_risk" });
    const atlasRun = scheduler.run("atlas", null, { mode: "auto_low_risk" });

    assert.notEqual(vegaRun.run_id, atlasRun.run_id);
    assert.equal(repository.listApprovalItems("vega").length, 1);
    assert.equal(repository.listApprovalItems("atlas").length, 1);
  } finally {
    repository.close();
  }
});
