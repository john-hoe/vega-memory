import type { DatabaseAdapter } from "../db/adapter.js";

import type {
  ReconciliationDimension,
  ReconciliationDirection,
  ReconciliationStatus
} from "./report.js";

export const RECONCILIATION_FINDINGS_TABLE = "reconciliation_findings";
export const RECONCILIATION_FINDINGS_DDL = `
  CREATE TABLE IF NOT EXISTS reconciliation_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    dimension TEXT NOT NULL CHECK (dimension IN ('count','shape','semantic','ordering','derived')),
    status TEXT NOT NULL CHECK (status IN ('pass','fail','not_implemented','error')),
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    event_type TEXT,
    direction TEXT CHECK (direction IN ('forward','reverse') OR direction IS NULL),
    expected INTEGER,
    actual INTEGER,
    mismatch_count INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )
`;

export const RECONCILIATION_FINDINGS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS reconciliation_findings_run_idx ON ${RECONCILIATION_FINDINGS_TABLE} (run_id)`,
  `CREATE INDEX IF NOT EXISTS reconciliation_findings_dim_idx ON ${RECONCILIATION_FINDINGS_TABLE} (dimension, created_at)`,
  `CREATE INDEX IF NOT EXISTS reconciliation_findings_created_idx ON ${RECONCILIATION_FINDINGS_TABLE} (created_at)`
] as const;

const RECONCILIATION_FINDINGS_ADD_COLUMNS = {
  run_id: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN run_id TEXT NOT NULL DEFAULT ''`,
  dimension: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN dimension TEXT NOT NULL DEFAULT 'count'`,
  status: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN status TEXT NOT NULL DEFAULT 'not_implemented'`,
  window_start: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN window_start INTEGER NOT NULL DEFAULT 0`,
  window_end: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN window_end INTEGER NOT NULL DEFAULT 0`,
  event_type: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN event_type TEXT`,
  direction: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN direction TEXT`,
  expected: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN expected INTEGER`,
  actual: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN actual INTEGER`,
  mismatch_count: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN mismatch_count INTEGER NOT NULL DEFAULT 0`,
  payload_json: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'`,
  created_at: `ALTER TABLE ${RECONCILIATION_FINDINGS_TABLE} ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`
} as const;

interface TableInfoRow {
  name: string;
}

interface RawReconciliationFindingRow {
  id: number;
  run_id: string;
  dimension: ReconciliationDimension;
  status: ReconciliationStatus;
  window_start: number;
  window_end: number;
  event_type: string | null;
  direction: ReconciliationDirection | null;
  expected: number | null;
  actual: number | null;
  mismatch_count: number;
  payload_json: string;
  created_at: number;
}

export interface ReconciliationFindingInsert {
  run_id: string;
  dimension: ReconciliationDimension;
  status: ReconciliationStatus;
  window_start: number;
  window_end: number;
  event_type?: string;
  direction?: ReconciliationDirection;
  expected?: number;
  actual?: number;
  mismatch_count: number;
  payload_json?: string;
  created_at: number;
}

export interface ReconciliationFindingRow {
  id: number;
  run_id: string;
  dimension: ReconciliationDimension;
  status: ReconciliationStatus;
  window_start: number;
  window_end: number;
  event_type: string | null;
  direction: ReconciliationDirection | null;
  expected: number | null;
  actual: number | null;
  mismatch_count: number;
  payload_json: string;
  payload: Record<string, unknown>;
  created_at: number;
}

export function applyReconciliationFindingsMigration(db: DatabaseAdapter): void {
  db.exec(RECONCILIATION_FINDINGS_DDL);
  const existingColumns = new Set(
    db
      .prepare<[], TableInfoRow>(`PRAGMA table_info(${RECONCILIATION_FINDINGS_TABLE})`)
      .all()
      .map((column) => column.name)
  );

  for (const [column, statement] of Object.entries(RECONCILIATION_FINDINGS_ADD_COLUMNS)) {
    if (!existingColumns.has(column)) {
      db.exec(statement);
    }
  }

  for (const statement of RECONCILIATION_FINDINGS_INDEXES) {
    db.exec(statement);
  }
}

export function insertReconciliationFindings(
  db: DatabaseAdapter,
  findings: ReconciliationFindingInsert[]
): void {
  if (findings.length === 0) {
    return;
  }

  const statement = db.prepare<
    [
      string,
      ReconciliationDimension,
      ReconciliationStatus,
      number,
      number,
      string | null,
      ReconciliationDirection | null,
      number | null,
      number | null,
      number,
      string,
      number
    ],
    never
  >(
    `INSERT INTO ${RECONCILIATION_FINDINGS_TABLE} (
      run_id,
      dimension,
      status,
      window_start,
      window_end,
      event_type,
      direction,
      expected,
      actual,
      mismatch_count,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.transaction(() => {
    for (const finding of findings) {
      statement.run(
        finding.run_id,
        finding.dimension,
        finding.status,
        finding.window_start,
        finding.window_end,
        finding.event_type ?? null,
        finding.direction ?? null,
        finding.expected ?? null,
        finding.actual ?? null,
        finding.mismatch_count,
        finding.payload_json ?? "{}",
        finding.created_at
      );
    }
  });
}

export function listReconciliationFindings(
  db: DatabaseAdapter,
  filters: {
    run_id?: string;
    dimension?: ReconciliationDimension;
  } = {}
): ReconciliationFindingRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.run_id !== undefined) {
    clauses.push("run_id = ?");
    params.push(filters.run_id);
  }

  if (filters.dimension !== undefined) {
    clauses.push("dimension = ?");
    params.push(filters.dimension);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare<unknown[], RawReconciliationFindingRow>(
      `SELECT * FROM ${RECONCILIATION_FINDINGS_TABLE} ${whereClause} ORDER BY created_at ASC, id ASC`
    )
    .all(...params);

  return rows.map((row) => ({
    ...row,
    payload: parsePayload(row.payload_json)
  }));
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
