import assert from "node:assert/strict";
import test from "node:test";

import { Repository } from "../db/repository.js";
import { applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import {
  applyReconciliationFindingsMigration,
  listReconciliationFindings
} from "../reconciliation/findings-store.js";
import { ReconciliationOrchestrator } from "../reconciliation/orchestrator.js";
import { pruneFindings } from "../reconciliation/retention.js";

const WINDOW_START = Date.parse("2026-04-20T00:00:00.000Z");
const WINDOW_END = Date.parse("2026-04-21T00:00:00.000Z");

test("orchestrator preserves all five current-run findings when retention_max_rows is 2", async () => {
  const repository = new Repository(":memory:");
  const previousRetentionDays = process.env.VEGA_RECONCILIATION_RETENTION_DAYS;
  const previousRetentionMaxRows = process.env.VEGA_RECONCILIATION_RETENTION_MAX_ROWS;

  process.env.VEGA_RECONCILIATION_RETENTION_DAYS = "30";
  process.env.VEGA_RECONCILIATION_RETENTION_MAX_ROWS = "2";

  try {
    applyRawInboxMigration(repository.db);
    const orchestrator = new ReconciliationOrchestrator({
      db: repository.db,
      now: () => WINDOW_END
    });
    const report = await orchestrator.run({
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      dimensions: ["count", "shape"]
    });

    const currentRunRows = listReconciliationFindings(repository.db, {
      run_id: report.run_id
    });

    assert.equal(currentRunRows.length, 5);
  } finally {
    if (previousRetentionDays === undefined) {
      delete process.env.VEGA_RECONCILIATION_RETENTION_DAYS;
    } else {
      process.env.VEGA_RECONCILIATION_RETENTION_DAYS = previousRetentionDays;
    }

    if (previousRetentionMaxRows === undefined) {
      delete process.env.VEGA_RECONCILIATION_RETENTION_MAX_ROWS;
    } else {
      process.env.VEGA_RECONCILIATION_RETENTION_MAX_ROWS = previousRetentionMaxRows;
    }

    repository.close();
  }
});

test("pruneFindings prunes older runs while preserving the protected current run", () => {
  const repository = new Repository(":memory:");
  const currentRunId = "current-run";

  try {
    applyReconciliationFindingsMigration(repository.db);

    for (let index = 0; index < 5; index += 1) {
      insertFinding(repository, {
        run_id: currentRunId,
        created_at: WINDOW_END - 40 * 86_400_000,
        mismatch_count: index
      });
    }

    for (let index = 0; index < 3; index += 1) {
      insertFinding(repository, {
        run_id: `old-run-${index}`,
        created_at: WINDOW_END - 41 * 86_400_000,
        mismatch_count: index
      });
    }

    const options = {
      now: () => WINDOW_END,
      retention_days: 30,
      retention_max_rows: 2,
      protect_run_id: currentRunId
    };

    pruneFindings(repository.db, options);

    const currentRunRows = listReconciliationFindings(repository.db, {
      run_id: currentRunId
    });
    const remainingRunIds = new Set(
      listReconciliationFindings(repository.db).map((row) => row.run_id)
    );

    assert.equal(currentRunRows.length, 5);
    assert.deepEqual([...remainingRunIds], [currentRunId]);
  } finally {
    repository.close();
  }
});

function insertFinding(
  repository: Repository,
  overrides: {
    run_id: string;
    created_at: number;
    mismatch_count?: number;
  }
): void {
  repository.db.run(
    `INSERT INTO reconciliation_findings (
      run_id, dimension, status, window_start, window_end, event_type, direction,
      expected, actual, mismatch_count, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    overrides.run_id,
    "count",
    "fail",
    WINDOW_START,
    WINDOW_END,
    "decision",
    "forward",
    1,
    0,
    overrides.mismatch_count ?? 1,
    JSON.stringify({ sample_ids: ["missing-id"] }),
    overrides.created_at
  );
}
