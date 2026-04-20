import { randomUUID } from "node:crypto";

import type { DatabaseAdapter } from "../db/adapter.js";

import {
  applyReconciliationFindingsMigration,
  insertReconciliationFindings
} from "./findings-store.js";
import { runCountDimension } from "./count-dimension.js";
import {
  buildReconciliationReport,
  DEFAULT_RECONCILIATION_DIMENSIONS,
  type ReconciliationDimension,
  type ReconciliationDimensionExecution,
  type ReconciliationDimensionReport
} from "./report.js";
import { pruneFindings, resolveReconciliationRetention } from "./retention.js";

export class ReconciliationOrchestrator {
  readonly #db: DatabaseAdapter;
  readonly #now: () => number;
  readonly #prune: (args: {
    db: DatabaseAdapter;
    retention_days: number;
    retention_max_rows: number;
    protect_run_id?: string;
  }) => void;

  constructor(options: {
    db: DatabaseAdapter;
    now?: () => number;
    prune?: (args: {
      db: DatabaseAdapter;
      retention_days: number;
      retention_max_rows: number;
      protect_run_id?: string;
    }) => void;
  }) {
    this.#db = options.db;
    this.#now = options.now ?? Date.now;
    this.#prune =
      options.prune ??
      ((args) =>
        pruneFindings(args.db, {
          now: this.#now,
          retention_days: args.retention_days,
          retention_max_rows: args.retention_max_rows,
          protect_run_id: args.protect_run_id
        }));
  }

  async run(args: {
    window_start: number;
    window_end: number;
    dimensions?: ReconciliationDimension[];
  }) {
    applyReconciliationFindingsMigration(this.#db);
    const runId = randomUUID();
    const createdAt = this.#now();
    const dimensions = dedupeDimensions(args.dimensions ?? [...DEFAULT_RECONCILIATION_DIMENSIONS]);
    const reports: ReconciliationDimensionReport[] = [];

    for (const dimension of dimensions) {
      const execution = await this.#executeDimension(dimension, args.window_start, args.window_end);
      insertReconciliationFindings(
        this.#db,
        execution.findings.map((finding) => ({
          run_id: runId,
          dimension,
          status: finding.status,
          window_start: args.window_start,
          window_end: args.window_end,
          event_type: finding.event_type,
          direction: finding.direction,
          expected: finding.expected,
          actual: finding.actual,
          mismatch_count: finding.mismatch_count,
          payload_json: JSON.stringify(finding.payload ?? {}),
          created_at: createdAt
        }))
      );
      reports.push({
        dimension,
        status: execution.status,
        findings: execution.findings.map((finding) => ({
          event_type: finding.event_type,
          direction: finding.direction,
          expected: finding.expected,
          actual: finding.actual,
          mismatch_count: finding.mismatch_count,
          sample_ids: Array.isArray(finding.payload?.sample_ids)
            ? (finding.payload?.sample_ids as string[])
            : undefined
        })),
        ...(execution.error !== undefined ? { error: execution.error } : {})
      });
    }

    const retention = resolveReconciliationRetention();
    this.#prune({
      db: this.#db,
      retention_days: retention.retention_days,
      retention_max_rows: retention.retention_max_rows,
      protect_run_id: runId
    });

    return buildReconciliationReport({
      run_id: runId,
      window_start: args.window_start,
      window_end: args.window_end,
      dimensions: reports,
      generated_at: createdAt
    });
  }

  async #executeDimension(
    dimension: ReconciliationDimension,
    windowStart: number,
    windowEnd: number
  ): Promise<ReconciliationDimensionExecution> {
    try {
      if (dimension === "count") {
        return await runCountDimension({
          db: this.#db,
          window_start: windowStart,
          window_end: windowEnd
        });
      }

      return createStubDimension(dimension);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        dimension,
        status: "error",
        error: message,
        findings: [
          {
            status: "error",
            mismatch_count: 0,
            payload: {
              error: message
            }
          }
        ]
      };
    }
  }
}

function createStubDimension(dimension: Exclude<ReconciliationDimension, "count">): ReconciliationDimensionExecution {
  return {
    dimension,
    status: "not_implemented",
    findings: [
      {
        status: "not_implemented",
        mismatch_count: 0,
        payload: {
          status: "not_implemented"
        }
      }
    ]
  };
}

function dedupeDimensions(dimensions: ReconciliationDimension[]): ReconciliationDimension[] {
  return [...new Set(dimensions)];
}
