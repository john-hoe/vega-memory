import assert from "node:assert/strict";
import test from "node:test";

import { Repository } from "../db/repository.js";
import { applyRawInboxMigration, insertRawEvent } from "../ingestion/raw-inbox.js";
import {
  applyReconciliationFindingsMigration,
  listReconciliationFindings
} from "../reconciliation/findings-store.js";
import { ReconciliationOrchestrator } from "../reconciliation/orchestrator.js";
import { pruneFindings } from "../reconciliation/retention.js";

const WINDOW_START = Date.parse("2026-04-20T00:00:00.000Z");
const WINDOW_END = Date.parse("2026-04-21T00:00:00.000Z");

function createMemory(id: string): Parameters<Repository["createMemory"]>[0] {
  return {
    id,
    tenant_id: null,
    type: "decision",
    project: "vega-memory",
    title: `Memory ${id}`,
    content: `Content ${id}`,
    summary: null,
    embedding: null,
    importance: 0.5,
    source: "explicit",
    tags: ["reconciliation"],
    created_at: "2026-04-20T12:00:00.000Z",
    updated_at: "2026-04-20T12:00:00.000Z",
    accessed_at: "2026-04-20T12:00:00.000Z",
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega-memory"],
    source_context: null
  };
}

function insertDecisionEnvelope(repository: Repository, eventId: string): void {
  insertRawEvent(repository.db, {
    schema_version: "1.0",
    event_id: eventId,
    surface: "api",
    session_id: "session-1",
    thread_id: null,
    project: "vega-memory",
    cwd: null,
    host_timestamp: "2026-04-20T12:00:00.000Z",
    role: "system",
    event_type: "decision",
    payload: {
      memory_type: "decision",
      title: `Envelope ${eventId}`,
      content: `Envelope ${eventId}`,
      summary: null,
      tags: ["reconciliation"]
    },
    safety: {
      redacted: false,
      categories: []
    },
    artifacts: [],
    source_kind: "vega_memory"
  });
}

test("orchestrator defaults to count plus three not_implemented stubs and excludes derived", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("11111111-1111-4111-8111-111111111111"));
    insertDecisionEnvelope(repository, "11111111-1111-4111-8111-111111111111");

    const orchestrator = new ReconciliationOrchestrator({
      db: repository.db,
      now: () => WINDOW_END
    });
    const report = await orchestrator.run({
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    assert.deepEqual(
      report.dimensions.map((dimension) => dimension.dimension),
      ["count", "shape", "semantic", "ordering"]
    );
    assert.equal(report.dimensions[0]?.status, "pass");
    assert.deepEqual(
      report.dimensions.slice(1).map((dimension) => dimension.status),
      ["not_implemented", "not_implemented", "not_implemented"]
    );
    assert.deepEqual(report.totals, {
      pass: 1,
      fail: 0,
      not_implemented: 3,
      error: 0
    });
  } finally {
    repository.close();
  }
});

test("orchestrator returns derived as not_implemented only when explicitly requested", async () => {
  const repository = new Repository(":memory:");

  try {
    const orchestrator = new ReconciliationOrchestrator({
      db: repository.db,
      now: () => WINDOW_END
    });
    const report = await orchestrator.run({
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      dimensions: ["derived"]
    });

    assert.deepEqual(report.dimensions.map((dimension) => dimension.dimension), ["derived"]);
    assert.equal(report.dimensions[0]?.status, "not_implemented");
    assert.deepEqual(report.totals, {
      pass: 0,
      fail: 0,
      not_implemented: 1,
      error: 0
    });
  } finally {
    repository.close();
  }
});

test("orchestrator prunes findings only after persisting the current run", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    let rowsSeenDuringPrune = 0;

    const orchestrator = new ReconciliationOrchestrator({
      db: repository.db,
      now: () => WINDOW_END,
      prune: ({ db }) => {
        rowsSeenDuringPrune = listReconciliationFindings(db).length;
      }
    });

    await orchestrator.run({
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      dimensions: ["shape"]
    });

    assert.equal(rowsSeenDuringPrune > 0, true);
  } finally {
    repository.close();
  }
});

test("pruneFindings drops aged rows by retention_days", () => {
  const repository = new Repository(":memory:");

  try {
    applyReconciliationFindingsMigration(repository.db);
    repository.db.run(
      `INSERT INTO reconciliation_findings (
        run_id, dimension, status, window_start, window_end, event_type, direction,
        expected, actual, mismatch_count, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "old-run",
      "count",
      "fail",
      1,
      2,
      "decision",
      "forward",
      1,
      0,
      1,
      JSON.stringify({ sample_ids: ["old"] }),
      WINDOW_END - 40 * 86_400_000
    );
    repository.db.run(
      `INSERT INTO reconciliation_findings (
        run_id, dimension, status, window_start, window_end, event_type, direction,
        expected, actual, mismatch_count, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "new-run",
      "count",
      "pass",
      1,
      2,
      "decision",
      "forward",
      1,
      1,
      0,
      JSON.stringify({ sample_ids: [] }),
      WINDOW_END
    );

    pruneFindings(repository.db, {
      now: () => WINDOW_END,
      retention_days: 30,
      retention_max_rows: 10_000
    });

    assert.deepEqual(
      listReconciliationFindings(repository.db).map((row) => row.run_id),
      ["new-run"]
    );
  } finally {
    repository.close();
  }
});

test("pruneFindings trims oldest rows when retention_max_rows is exceeded", () => {
  const repository = new Repository(":memory:");

  try {
    applyReconciliationFindingsMigration(repository.db);

    for (let index = 0; index < 3; index += 1) {
      repository.db.run(
        `INSERT INTO reconciliation_findings (
          run_id, dimension, status, window_start, window_end, event_type, direction,
          expected, actual, mismatch_count, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `run-${index}`,
        "shape",
        "not_implemented",
        1,
        2,
        null,
        null,
        null,
        null,
        0,
        JSON.stringify({}),
        WINDOW_START + index
      );
    }

    pruneFindings(repository.db, {
      now: () => WINDOW_END,
      retention_days: 30,
      retention_max_rows: 2
    });

    assert.deepEqual(
      listReconciliationFindings(repository.db).map((row) => row.run_id),
      ["run-1", "run-2"]
    );
  } finally {
    repository.close();
  }
});
