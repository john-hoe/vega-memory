import type { DatabaseAdapter } from "../db/adapter.js";

export const ALERT_HISTORY_TABLE = "alert_history";
export const ALERT_HISTORY_DDL = `
  CREATE TABLE IF NOT EXISTS ${ALERT_HISTORY_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    value REAL NOT NULL,
    fired_at INTEGER NOT NULL,
    resolved_at INTEGER NULL,
    channels TEXT NOT NULL,
    dispatch_status TEXT NOT NULL
  )
`;
export const ALERT_HISTORY_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_alert_history_rule_fired ON ${ALERT_HISTORY_TABLE}(rule_id, fired_at)`,
  `CREATE INDEX IF NOT EXISTS idx_alert_history_fired ON ${ALERT_HISTORY_TABLE}(fired_at)`
] as const;

interface AlertHistoryRow {
  id: number;
  fired_at: number;
}

export interface AlertHistoryInsert {
  rule_id: string;
  severity: string;
  value: number;
  fired_at: number;
  channels: string[];
  dispatch_status: Record<string, string>;
}

export function applyAlertHistoryMigration(db: DatabaseAdapter): void {
  if (db.isPostgres) return;

  db.exec(ALERT_HISTORY_DDL);

  for (const statement of ALERT_HISTORY_INDEXES) {
    db.exec(statement);
  }
}

export function isInCooldown(
  db: DatabaseAdapter,
  rule_id: string,
  now: number,
  cooldownMs: number
): boolean {
  if (db.isPostgres) {
    return false;
  }

  const row = db.get<AlertHistoryRow>(
    `SELECT id, fired_at
     FROM ${ALERT_HISTORY_TABLE}
     WHERE rule_id = ? AND resolved_at IS NULL
     ORDER BY fired_at DESC, id DESC
     LIMIT 1`,
    rule_id
  );

  return row !== undefined && now - row.fired_at < cooldownMs;
}

export function recordAlertFired(db: DatabaseAdapter, entry: AlertHistoryInsert): void {
  if (db.isPostgres) {
    return;
  }

  db.run(
    `INSERT INTO ${ALERT_HISTORY_TABLE} (
      rule_id,
      severity,
      value,
      fired_at,
      resolved_at,
      channels,
      dispatch_status
    ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    entry.rule_id,
    entry.severity,
    entry.value,
    entry.fired_at,
    JSON.stringify(entry.channels),
    JSON.stringify(entry.dispatch_status)
  );
}

export function markAlertResolved(
  db: DatabaseAdapter,
  rule_id: string,
  resolved_at: number
): void {
  if (db.isPostgres) {
    return;
  }

  const row = db.get<AlertHistoryRow>(
    `SELECT id, fired_at
     FROM ${ALERT_HISTORY_TABLE}
     WHERE rule_id = ? AND resolved_at IS NULL
     ORDER BY fired_at DESC, id DESC
     LIMIT 1`,
    rule_id
  );

  if (row === undefined) {
    return;
  }

  db.run(
    `UPDATE ${ALERT_HISTORY_TABLE}
     SET resolved_at = ?
     WHERE id = ?`,
    resolved_at,
    row.id
  );
}
