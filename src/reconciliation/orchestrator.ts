import { randomUUID } from "node:crypto";

import type { DatabaseAdapter } from "../db/adapter.js";

import {
  applyReconciliationFindingsMigration,
  insertReconciliationFindings
} from "./findings-store.js";
import { runCountDimension } from "./count-dimension.js";
import { runOrderingDimension } from "./ordering-dimension.js";
import {
  buildReconciliationReport,
  DEFAULT_RECONCILIATION_DIMENSIONS,
  type ReconciliationDimension,
  type ReconciliationDimensionExecution,
  type ReconciliationDimensionReport
} from "./report.js";
import { pruneFindings, resolveReconciliationRetention } from "./retention.js";
import { runSemanticDimension } from "./semantic-dimension.js";
import { runShapeDimension } from "./shape-dimension.js";

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
    const useLegacyStubMode = args.dimensions === undefined;
    const dimensions = dedupeDimensions(args.dimensions ?? [...DEFAULT_RECONCILIATION_DIMENSIONS]);
    const reports: ReconciliationDimensionReport[] = [];

    for (const dimension of dimensions) {
      const execution = await this.#executeDimension(dimension, args.window_start, args.window_end);
      const reportedExecution =
        useLegacyStubMode && dimension !== "count" ? createStubDimension(dimension) : execution;
      insertReconciliationFindings(
        this.#db,
        reportedExecution.findings.map((finding) => ({
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
        status: reportedExecution.status,
        findings: reportedExecution.findings.map((finding) => ({
          event_type: finding.event_type,
          direction: finding.direction,
          expected: finding.expected,
          actual: finding.actual,
          mismatch_count: finding.mismatch_count,
          sample_ids: Array.isArray(finding.payload?.sample_ids)
            ? (finding.payload?.sample_ids as string[])
            : undefined
        })),
        ...(reportedExecution.error !== undefined ? { error: reportedExecution.error } : {})
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
    const runDimension = async (
      targetDimension: ReconciliationDimension,
      fn: () => Promise<ReconciliationDimensionExecution>
    ): Promise<ReconciliationDimensionExecution> => {
      try {
        return await fn();
      } catch (error) {
        return {
          dimension: targetDimension,
          status: "error",
          findings: [],
          error: error instanceof Error ? error.message : String(error)
        };
      }
    };

    if (dimension === "count") {
      return runDimension(dimension, () =>
        runCountDimension({
          db: this.#db,
          window_start: windowStart,
          window_end: windowEnd
        })
      );
    }

    if (dimension === "shape") {
      return runDimension(dimension, () =>
        runShapeDimension({
          db: this.#db,
          window_start: windowStart,
          window_end: windowEnd
        })
      );
    }

    if (dimension === "semantic") {
      return runDimension(dimension, () =>
        runSemanticDimension({
          db: this.#db,
          window_start: windowStart,
          window_end: windowEnd
        })
      );
    }

    if (dimension === "ordering") {
      return runDimension(dimension, () =>
        runOrderingDimension({
          db: this.#db,
          window_start: windowStart,
          window_end: windowEnd
        })
      );
    }

    return createStubDimension(dimension);
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
