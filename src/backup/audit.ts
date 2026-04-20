import type { DatabaseAdapter } from "../db/adapter.js";

export const RESTORE_AUDIT_TABLE = "restore_audit";
export const RESTORE_AUDIT_DDL = `
  CREATE TABLE IF NOT EXISTS ${RESTORE_AUDIT_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backup_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    operator TEXT NOT NULL,
    before_state_sha256 TEXT,
    after_state_sha256 TEXT,
    restored_at INTEGER NOT NULL,
    verified INTEGER NOT NULL,
    mismatches_json TEXT NOT NULL
  )
`;
export const RESTORE_AUDIT_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_restore_audit_backup ON ${RESTORE_AUDIT_TABLE}(backup_id, restored_at)`
] as const;

export interface RestoreAuditRecord {
  backup_id: string;
  mode: "full" | "selective" | "drill";
  operator: string;
  before_state_sha256: string | null;
  after_state_sha256: string | null;
  restored_at: number;
  verified: boolean;
  mismatches: string[];
}

export interface RestoreAuditRow extends RestoreAuditRecord {
  id: number;
}

export function applyRestoreAuditMigration(db: DatabaseAdapter): void {
  if (db.isPostgres) return;

  db.exec(RESTORE_AUDIT_DDL);

  for (const statement of RESTORE_AUDIT_INDEXES) {
    db.exec(statement);
  }
}

export function recordRestoreAudit(db: DatabaseAdapter, record: RestoreAuditRecord): void {
  if (db.isPostgres) {
    return;
  }

  db.run(
    `INSERT INTO ${RESTORE_AUDIT_TABLE} (
      backup_id,
      mode,
      operator,
      before_state_sha256,
      after_state_sha256,
      restored_at,
      verified,
      mismatches_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    record.backup_id,
    record.mode,
    record.operator,
    record.before_state_sha256,
    record.after_state_sha256,
    record.restored_at,
    record.verified ? 1 : 0,
    JSON.stringify(record.mismatches)
  );
}

export function listRestoreAudit(
  db: DatabaseAdapter,
  options: {
    limit: number;
  }
): RestoreAuditRow[] {
  if (db.isPostgres) {
    return [];
  }

  return db
    .all<{
      id: number;
      backup_id: string;
      mode: "full" | "selective" | "drill";
      operator: string;
      before_state_sha256: string | null;
      after_state_sha256: string | null;
      restored_at: number;
      verified: number;
      mismatches_json: string;
    }>(
      `SELECT
         id,
         backup_id,
         mode,
         operator,
         before_state_sha256,
         after_state_sha256,
         restored_at,
         verified,
         mismatches_json
       FROM ${RESTORE_AUDIT_TABLE}
       ORDER BY restored_at DESC, id DESC
       LIMIT ?`,
      options.limit
    )
    .map((row) => ({
      id: row.id,
      backup_id: row.backup_id,
      mode: row.mode,
      operator: row.operator,
      before_state_sha256: row.before_state_sha256,
      after_state_sha256: row.after_state_sha256,
      restored_at: row.restored_at,
      verified: row.verified === 1,
      mismatches: JSON.parse(row.mismatches_json) as string[]
    }));
}
