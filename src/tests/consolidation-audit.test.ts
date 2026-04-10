import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { ConsolidationAuditService } from "../core/consolidation-audit.js";
import { ConsolidationDashboardService } from "../core/consolidation-dashboard.js";
import type { ConsolidationRunRecord } from "../core/types.js";
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

const createRunRecord = (
  overrides: Partial<ConsolidationRunRecord> = {}
): ConsolidationRunRecord => ({
  run_id: "run-1",
  project: "vega",
  tenant_id: null,
  trigger: "manual",
  mode: "dry_run",
  started_at: "2026-04-10T00:00:00.000Z",
  completed_at: "2026-04-10T00:00:01.000Z",
  duration_ms: 1000,
  total_candidates: 3,
  actions_executed: 1,
  actions_skipped: 2,
  errors: [],
  ...overrides
});

test("records and retrieves run", () => {
  const repository = new Repository(":memory:");
  const auditService = new ConsolidationAuditService(repository);

  try {
    const record = createRunRecord();
    auditService.recordRun(record, "{\"ok\":true}");

    assert.deepEqual(auditService.getLastRun("vega"), record);
  } finally {
    repository.close();
  }
});

test("idempotency prevents duplicate runs", () => {
  const repository = new Repository(":memory:");
  const auditService = new ConsolidationAuditService(repository);

  try {
    auditService.recordRun(createRunRecord({ run_id: "run-idempotent" }));

    assert.equal(auditService.isIdempotent("run-idempotent"), true);
    assert.equal(auditService.isIdempotent("missing-run"), false);
  } finally {
    repository.close();
  }
});

test("list runs returns chronological order", () => {
  const repository = new Repository(":memory:");
  const auditService = new ConsolidationAuditService(repository);

  try {
    auditService.recordRun(
      createRunRecord({
        run_id: "run-1",
        completed_at: "2026-04-10T00:00:01.000Z"
      })
    );
    auditService.recordRun(
      createRunRecord({
        run_id: "run-2",
        completed_at: "2026-04-10T00:00:02.000Z"
      })
    );
    auditService.recordRun(
      createRunRecord({
        run_id: "run-3",
        completed_at: "2026-04-10T00:00:03.000Z"
      })
    );

    const runs = auditService.listRuns("vega", 2);

    assert.deepEqual(
      runs.map((run) => run.run_id),
      ["run-3", "run-2"]
    );
  } finally {
    repository.close();
  }
});

test("dashboard history reflects recorded runs", () => {
  const repository = new Repository(":memory:");
  const auditService = new ConsolidationAuditService(repository);
  const dashboardService = new ConsolidationDashboardService(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      factClaims: true
    }
  });

  try {
    auditService.recordRun(
      createRunRecord({
        run_id: "run-1",
        completed_at: "2026-04-10T00:00:01.000Z",
        total_candidates: 2,
        actions_executed: 1
      })
    );
    auditService.recordRun(
      createRunRecord({
        run_id: "run-2",
        completed_at: "2026-04-10T00:00:03.000Z",
        total_candidates: 5,
        actions_executed: 2
      })
    );

    const dashboard = dashboardService.generateDashboard("vega");

    assert.equal(
      dashboard.consolidation_history.last_report_at,
      "2026-04-10T00:00:03.000Z"
    );
    assert.equal(dashboard.consolidation_history.total_reports_generated, 2);
    assert.equal(dashboard.consolidation_history.total_candidates_found, 7);
    assert.equal(dashboard.consolidation_history.total_candidates_resolved, 3);
  } finally {
    repository.close();
  }
});
