import { v4 as uuidv4 } from "uuid";

import type { DatabaseAdapter } from "../db/adapter.js";
import type { PromotionAction, PromotionAuditState, PromotionTrigger } from "./policy.js";

export interface PromotionAuditEntry {
  id: string;
  memory_id: string;
  project: string | null;
  action: PromotionAction;
  trigger: PromotionTrigger;
  from_state: PromotionAuditState;
  to_state: PromotionAuditState;
  policy_name: string;
  policy_version: string;
  reason: string;
  actor: string | null;
  occurred_at: number;
}

export interface PromotionAuditStore {
  put(entry: Omit<PromotionAuditEntry, "id" | "occurred_at">): PromotionAuditEntry;
  listByMemory(memory_id: string, limit?: number): PromotionAuditEntry[];
  listRecent(limit?: number): PromotionAuditEntry[];
  size(): number;
}

interface PromotionAuditRow extends PromotionAuditEntry {}

const PROMOTION_AUDIT_TABLE = "promotion_audit";
const DEFAULT_LIMIT = 50;

const PROMOTION_AUDIT_DDL = `
  CREATE TABLE IF NOT EXISTS ${PROMOTION_AUDIT_TABLE} (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    project TEXT,
    action TEXT NOT NULL,
    trigger TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    policy_name TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor TEXT,
    occurred_at INTEGER NOT NULL
  )
`;

const PROMOTION_AUDIT_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_promotion_audit_memory ON ${PROMOTION_AUDIT_TABLE}(memory_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_audit_occurred ON ${PROMOTION_AUDIT_TABLE}(occurred_at DESC)`
] as const;

function resolveLimit(limit?: number): number {
  return Number.isInteger(limit) && limit !== undefined && limit > 0 ? limit : DEFAULT_LIMIT;
}

export function applyPromotionAuditMigration(db: DatabaseAdapter): void {
  db.exec(PROMOTION_AUDIT_DDL);

  const columns = new Set(
    db
      .prepare<[], { name: string }>(`PRAGMA table_info(${PROMOTION_AUDIT_TABLE})`)
      .all()
      .map((column) => column.name)
  );

  if (!columns.has("project")) {
    db.exec(`ALTER TABLE ${PROMOTION_AUDIT_TABLE} ADD COLUMN project TEXT`);
  }

  for (const statement of PROMOTION_AUDIT_INDEXES) {
    db.exec(statement);
  }
}

export function createPromotionAuditStore(
  db: DatabaseAdapter,
  options: { now?: () => number; idFactory?: () => string } = {}
): PromotionAuditStore {
  applyPromotionAuditMigration(db);

  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? (() => uuidv4());
  const insertStatement = db.prepare<
    [string, string, string | null, string, string, string, string, string, string, string, string | null, number],
    never
  >(
    `INSERT INTO ${PROMOTION_AUDIT_TABLE} (
      id,
      memory_id,
      project,
      action,
      trigger,
      from_state,
      to_state,
      policy_name,
      policy_version,
      reason,
      actor,
      occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  return {
    put(entry): PromotionAuditEntry {
      const stored: PromotionAuditEntry = {
        ...entry,
        id: idFactory(),
        occurred_at: now()
      };

      insertStatement.run(
        stored.id,
        stored.memory_id,
        stored.project,
        stored.action,
        stored.trigger,
        stored.from_state,
        stored.to_state,
        stored.policy_name,
        stored.policy_version,
        stored.reason,
        stored.actor,
        stored.occurred_at
      );

      return stored;
    },
    listByMemory(memory_id, limit = DEFAULT_LIMIT): PromotionAuditEntry[] {
      return db.all<PromotionAuditRow>(
        `SELECT
          id,
          memory_id,
          project,
          action,
          trigger,
          from_state,
          to_state,
          policy_name,
          policy_version,
          reason,
          actor,
          occurred_at
        FROM ${PROMOTION_AUDIT_TABLE}
        WHERE memory_id = ?
        ORDER BY occurred_at DESC
        LIMIT ?`,
        memory_id,
        resolveLimit(limit)
      );
    },
    listRecent(limit = DEFAULT_LIMIT): PromotionAuditEntry[] {
      return db.all<PromotionAuditRow>(
        `SELECT
          id,
          memory_id,
          project,
          action,
          trigger,
          from_state,
          to_state,
          policy_name,
          policy_version,
          reason,
          actor,
          occurred_at
        FROM ${PROMOTION_AUDIT_TABLE}
        ORDER BY occurred_at DESC
        LIMIT ?`,
        resolveLimit(limit)
      );
    },
    size(): number {
      return (
        db.get<{ count: number }>(
          `SELECT COUNT(*) as count FROM ${PROMOTION_AUDIT_TABLE}`
        )?.count ?? 0
      );
    }
  };
}
