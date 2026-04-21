import type { HostTier, Sufficiency } from "../core/contracts/enums.js";
import {
  applyCheckpointStoreMigration,
  RESOLVED_CHECKPOINTS_TABLE
} from "./checkpoint-store.js";
import type { DatabaseAdapter } from "../db/adapter.js";

export interface AckRecord {
  checkpoint_id: string;
  bundle_digest: string;
  sufficiency: Sufficiency;
  host_tier: HostTier;
  evidence: string | null;
  turn_elapsed_ms: number | null;
  session_id: string | null;
  acked_at: number;
  guard_overridden: boolean;
}

export type AckPutStatus = "inserted" | "idempotent" | "conflict";

export interface AckPutResult {
  record: AckRecord;
  status: AckPutStatus;
}

export interface AckCountFilter {
  session_id: string;
  sufficiency: Sufficiency;
  since: number;
  exclude_checkpoint_id?: string;
}

export interface AckStore {
  put(ack: Omit<AckRecord, "acked_at" | "guard_overridden">): AckPutResult;
  get(checkpoint_id: string): AckRecord | undefined;
  overrideSufficiency(checkpoint_id: string, sufficiency: Sufficiency): void;
  countRecent(filter: AckCountFilter): number;
  listRecent?(filter: {
    since: number;
    sufficiency?: Sufficiency;
  }): ReadonlyArray<AckRecord>;
  listRecentForRecord?(record_id: string, filter: {
    since: number;
    sufficiency?: Sufficiency;
  }): ReadonlyArray<AckRecord>;
  size(): number;
}

export interface AckStoreOptions {
  now?: () => number;
}

interface AckRow {
  checkpoint_id: string;
  bundle_digest: string;
  sufficiency: Sufficiency;
  host_tier: HostTier;
  evidence: string | null;
  turn_elapsed_ms: number | null;
  session_id: string | null;
  acked_at: number;
  guard_overridden: number;
}

interface TableInfoRow {
  name: string;
}

export const USAGE_ACKS_TABLE = "usage_acks";

const ACK_STORE_DDL = `
  CREATE TABLE IF NOT EXISTS ${USAGE_ACKS_TABLE} (
    checkpoint_id TEXT PRIMARY KEY,
    bundle_digest TEXT NOT NULL,
    sufficiency TEXT NOT NULL,
    host_tier TEXT NOT NULL,
    evidence TEXT,
    turn_elapsed_ms INTEGER,
    session_id TEXT,
    acked_at INTEGER NOT NULL,
    guard_overridden INTEGER NOT NULL DEFAULT 0
  )
`;

const ACK_STORE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_usage_acks_sufficiency ON ${USAGE_ACKS_TABLE}(sufficiency, acked_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_acks_session_sufficiency ON ${USAGE_ACKS_TABLE}(session_id, sufficiency, acked_at DESC)`
] as const;

export function applyAckStoreMigration(db: DatabaseAdapter): void {
  db.exec(ACK_STORE_DDL);
  const columnNames = new Set(
    db
      .prepare<[], TableInfoRow>(`PRAGMA table_info(${USAGE_ACKS_TABLE})`)
      .all()
      .map((column) => column.name)
  );

  if (!columnNames.has("session_id")) {
    db.exec(`ALTER TABLE ${USAGE_ACKS_TABLE} ADD COLUMN session_id TEXT`);
  }

  if (!columnNames.has("guard_overridden")) {
    db.exec(
      `ALTER TABLE ${USAGE_ACKS_TABLE} ADD COLUMN guard_overridden INTEGER NOT NULL DEFAULT 0`
    );
  }

  for (const statement of ACK_STORE_INDEXES) {
    db.exec(statement);
  }
}

export function createAckStore(
  db: DatabaseAdapter,
  options: AckStoreOptions = {}
): AckStore {
  applyAckStoreMigration(db);
  applyCheckpointStoreMigration(db);

  const now = options.now ?? (() => Date.now());
  const insertStatement = db.prepare<
    [string, string, Sufficiency, HostTier, string | null, number | null, string | null, number, number],
    never
  >(
    `INSERT INTO ${USAGE_ACKS_TABLE} (
      checkpoint_id,
      bundle_digest,
      sufficiency,
      host_tier,
      evidence,
      turn_elapsed_ms,
      session_id,
      acked_at,
      guard_overridden
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const getStatement = db.prepare<[string], AckRow>(
    `SELECT
      checkpoint_id,
      bundle_digest,
      sufficiency,
      host_tier,
      evidence,
      turn_elapsed_ms,
      session_id,
      acked_at,
      guard_overridden
    FROM ${USAGE_ACKS_TABLE}
    WHERE checkpoint_id = ?`
  );
  const overrideStatement = db.prepare<[Sufficiency, string], never>(
    `UPDATE ${USAGE_ACKS_TABLE}
    SET sufficiency = ?, guard_overridden = 1
    WHERE checkpoint_id = ?`
  );
  const countRecentStatement = db.prepare<
    [string, Sufficiency, number, string | null, string | null],
    { count: number }
  >(
    `SELECT COUNT(DISTINCT checkpoint_id) as count
    FROM ${USAGE_ACKS_TABLE}
    WHERE session_id = ?
      AND sufficiency = ?
      AND acked_at >= ?
      AND (? IS NULL OR checkpoint_id != ?)`
  );
  const listRecentStatement = db.prepare<
    [number, Sufficiency | null, Sufficiency | null],
    AckRow
  >(
    `SELECT
      checkpoint_id,
      bundle_digest,
      sufficiency,
      host_tier,
      evidence,
      turn_elapsed_ms,
      session_id,
      acked_at,
      guard_overridden
    FROM ${USAGE_ACKS_TABLE}
    WHERE acked_at >= ?
      AND (? IS NULL OR sufficiency = ?)
    ORDER BY acked_at DESC, checkpoint_id ASC`
  );
  const listRecentForRecordStatement = db.prepare<
    [string, number, Sufficiency | null, Sufficiency | null],
    AckRow
  >(
    `SELECT DISTINCT
      usage_acks.checkpoint_id,
      usage_acks.bundle_digest,
      usage_acks.sufficiency,
      usage_acks.host_tier,
      usage_acks.evidence,
      usage_acks.turn_elapsed_ms,
      usage_acks.session_id,
      usage_acks.acked_at,
      usage_acks.guard_overridden
    FROM ${USAGE_ACKS_TABLE} AS usage_acks
    JOIN ${RESOLVED_CHECKPOINTS_TABLE} AS resolved_checkpoints
      ON resolved_checkpoints.checkpoint_id = usage_acks.checkpoint_id
    JOIN json_each(resolved_checkpoints.record_ids) AS record_ids
      ON record_ids.value = ?
    WHERE usage_acks.acked_at >= ?
      AND (? IS NULL OR usage_acks.sufficiency = ?)
    ORDER BY usage_acks.acked_at DESC, usage_acks.checkpoint_id ASC`
  );

  const toAckRecord = (row: AckRow): AckRecord => ({
    checkpoint_id: row.checkpoint_id,
    bundle_digest: row.bundle_digest,
    sufficiency: row.sufficiency,
    host_tier: row.host_tier,
    evidence: row.evidence,
    turn_elapsed_ms: row.turn_elapsed_ms,
    session_id: row.session_id,
    acked_at: row.acked_at,
    guard_overridden: row.guard_overridden === 1
  });

  const isContentEqual = (
    existing: AckRecord,
    incoming: Omit<AckRecord, "acked_at" | "guard_overridden">
  ): boolean =>
    existing.bundle_digest === incoming.bundle_digest &&
    existing.host_tier === incoming.host_tier;

  return {
    put(ack: Omit<AckRecord, "acked_at" | "guard_overridden">): AckPutResult {
      return db.transaction(() => {
        const existing = getStatement.get(ack.checkpoint_id);
        if (existing !== undefined) {
          const record = toAckRecord(existing);
          return {
            record,
            status: isContentEqual(record, ack) ? "idempotent" : "conflict"
          } satisfies AckPutResult;
        }

        const stored: AckRecord = {
          ...ack,
          evidence: ack.evidence ?? null,
          turn_elapsed_ms: ack.turn_elapsed_ms ?? null,
          session_id: ack.session_id ?? null,
          acked_at: now(),
          guard_overridden: false
        };

        insertStatement.run(
          stored.checkpoint_id,
          stored.bundle_digest,
          stored.sufficiency,
          stored.host_tier,
          stored.evidence,
          stored.turn_elapsed_ms,
          stored.session_id,
          stored.acked_at,
          0
        );

        return {
          record: stored,
          status: "inserted"
        } satisfies AckPutResult;
      });
    },
    get(checkpoint_id: string): AckRecord | undefined {
      const row = getStatement.get(checkpoint_id);
      return row === undefined ? undefined : toAckRecord(row);
    },
    overrideSufficiency(checkpoint_id: string, sufficiency: Sufficiency): void {
      overrideStatement.run(sufficiency, checkpoint_id);
    },
    countRecent(filter: AckCountFilter): number {
      const exclude_checkpoint_id = filter.exclude_checkpoint_id ?? null;
      return countRecentStatement.get(
        filter.session_id,
        filter.sufficiency,
        filter.since,
        exclude_checkpoint_id,
        exclude_checkpoint_id
      )?.count ?? 0;
    },
    listRecent(filter: { since: number; sufficiency?: Sufficiency }): ReadonlyArray<AckRecord> {
      const sufficiency = filter.sufficiency ?? null;
      return listRecentStatement
        .all(filter.since, sufficiency, sufficiency)
        .map(toAckRecord);
    },
    listRecentForRecord(
      record_id: string,
      filter: { since: number; sufficiency?: Sufficiency }
    ): ReadonlyArray<AckRecord> {
      const sufficiency = filter.sufficiency ?? null;
      return listRecentForRecordStatement
        .all(record_id, filter.since, sufficiency, sufficiency)
        .map(toAckRecord);
    },
    size(): number {
      return db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${USAGE_ACKS_TABLE}`
      )?.count ?? 0;
    }
  };
}
