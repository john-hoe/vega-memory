import type { DatabaseAdapter } from "../db/adapter.js";

import { RECONCILIATION_FINDINGS_TABLE } from "./findings-store.js";

export const DEFAULT_RECONCILIATION_RETENTION_DAYS = 30;
export const DEFAULT_RECONCILIATION_RETENTION_MAX_ROWS = 10_000;

interface CountRow {
  row_count: number;
}

export interface PruneFindingsOptions {
  now?: () => number;
  retention_days: number;
  retention_max_rows: number;
  protect_run_id?: string;
}

export function resolveReconciliationRetention(env: NodeJS.ProcessEnv = process.env): {
  retention_days: number;
  retention_max_rows: number;
} {
  return {
    retention_days: parsePositiveInteger(
      env.VEGA_RECONCILIATION_RETENTION_DAYS,
      DEFAULT_RECONCILIATION_RETENTION_DAYS
    ),
    retention_max_rows: parsePositiveInteger(
      env.VEGA_RECONCILIATION_RETENTION_MAX_ROWS,
      DEFAULT_RECONCILIATION_RETENTION_MAX_ROWS
    )
  };
}

export function pruneFindings(
  db: DatabaseAdapter,
  options: PruneFindingsOptions
): void {
  const now = options.now ?? Date.now;
  const cutoff = now() - options.retention_days * 86_400_000;
  const protectCurrentRunClause = options.protect_run_id === undefined ? "" : " AND run_id != ?";

  if (options.protect_run_id === undefined) {
    db.run(
      `DELETE FROM ${RECONCILIATION_FINDINGS_TABLE}
       WHERE created_at < ?`,
      cutoff
    );
  } else {
    db.run(
      `DELETE FROM ${RECONCILIATION_FINDINGS_TABLE}
       WHERE created_at < ?${protectCurrentRunClause}`,
      cutoff,
      options.protect_run_id
    );
  }

  const rowCount =
    db.get<CountRow>(`SELECT COUNT(*) AS row_count FROM ${RECONCILIATION_FINDINGS_TABLE}`)?.row_count ?? 0;
  const overflow = rowCount - options.retention_max_rows;

  if (overflow > 0) {
    if (options.protect_run_id === undefined) {
      db.run(
        `DELETE FROM ${RECONCILIATION_FINDINGS_TABLE}
         WHERE id IN (
           SELECT id
           FROM ${RECONCILIATION_FINDINGS_TABLE}
           ORDER BY created_at ASC, id ASC
           LIMIT ?
         )`,
        overflow
      );
    } else {
      db.run(
        `DELETE FROM ${RECONCILIATION_FINDINGS_TABLE}
         WHERE id IN (
           SELECT id
           FROM ${RECONCILIATION_FINDINGS_TABLE}
           WHERE run_id != ?
           ORDER BY created_at ASC, id ASC
           LIMIT ?
         )`,
        options.protect_run_id,
        overflow
      );
    }
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
