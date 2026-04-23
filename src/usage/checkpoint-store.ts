import type { CheckpointRecord, CheckpointRecordInput } from "../core/contracts/checkpoint-record.js";
import { CHECKPOINT_RECORD_SCHEMA } from "../core/contracts/checkpoint-record.js";
import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";

export interface CheckpointStore {
  put(record: Omit<CheckpointRecordInput, "created_at" | "ttl_expires_at">): void;
  get(checkpoint_id: string, now?: number): CheckpointRecord | undefined;
  evictExpired(now?: number): number;
  size(): number;
}

export interface CheckpointStoreOptions {
  ttl_ms?: number;
  now?: () => number;
}

interface CheckpointRow {
  checkpoint_id: string;
  bundle_digest: string;
  intent: string;
  surface: string;
  session_id: string;
  project: string | null;
  cwd: string | null;
  query_hash: string;
  mode: string;
  profile_used: string;
  ranker_version: string;
  record_ids: string;
  prev_checkpoint_id: string | null;
  lineage_root_checkpoint_id: string;
  followup_depth: number;
  created_at: number;
  ttl_expires_at: number;
}

export const RESOLVED_CHECKPOINTS_TABLE = "resolved_checkpoints";
export const DEFAULT_CHECKPOINT_TTL_MS = 1_800_000;
const logger = createLogger({ name: "checkpoint-store" });

const CHECKPOINT_STORE_DDL = `
  CREATE TABLE IF NOT EXISTS ${RESOLVED_CHECKPOINTS_TABLE} (
    checkpoint_id TEXT PRIMARY KEY,
    bundle_digest TEXT NOT NULL,
    intent TEXT NOT NULL,
    surface TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project TEXT,
    cwd TEXT,
    query_hash TEXT NOT NULL,
    mode TEXT NOT NULL,
    profile_used TEXT NOT NULL,
    ranker_version TEXT NOT NULL,
    record_ids TEXT NOT NULL,
    prev_checkpoint_id TEXT,
    lineage_root_checkpoint_id TEXT NOT NULL DEFAULT '',
    followup_depth INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    ttl_expires_at INTEGER NOT NULL
  )
`;

const CHECKPOINT_STORE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_resolved_checkpoints_session ON ${RESOLVED_CHECKPOINTS_TABLE}(session_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_resolved_checkpoints_ttl_expires ON ${RESOLVED_CHECKPOINTS_TABLE}(ttl_expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_resolved_checkpoints_lineage_root ON ${RESOLVED_CHECKPOINTS_TABLE}(lineage_root_checkpoint_id, created_at DESC)`
] as const;

function parseRecordIds(value: string): string[] {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function toCheckpointRecord(row: CheckpointRow): CheckpointRecord {
  return CHECKPOINT_RECORD_SCHEMA.parse({
    ...row,
    record_ids: parseRecordIds(row.record_ids)
  });
}

export function resolveCheckpointStoreTtlMs(ttl_ms?: number): number {
  if (ttl_ms !== undefined && Number.isInteger(ttl_ms) && ttl_ms > 0) {
    return ttl_ms;
  }

  const envValue = Number.parseInt(process.env.VEGA_CHECKPOINT_TTL_MS ?? "", 10);
  return Number.isInteger(envValue) && envValue > 0 ? envValue : DEFAULT_CHECKPOINT_TTL_MS;
}

export function applyCheckpointStoreMigration(db: DatabaseAdapter): void {
  db.exec(CHECKPOINT_STORE_DDL);

  const columns = new Set(
    db
      .prepare<[], { name: string }>(`PRAGMA table_info(${RESOLVED_CHECKPOINTS_TABLE})`)
      .all()
      .map((column) => column.name)
  );

  if (!columns.has("prev_checkpoint_id")) {
    db.exec(`ALTER TABLE ${RESOLVED_CHECKPOINTS_TABLE} ADD COLUMN prev_checkpoint_id TEXT`);
  }

  if (!columns.has("lineage_root_checkpoint_id")) {
    db.exec(
      `ALTER TABLE ${RESOLVED_CHECKPOINTS_TABLE} ADD COLUMN lineage_root_checkpoint_id TEXT NOT NULL DEFAULT ''`
    );
  }

  if (!columns.has("followup_depth")) {
    db.exec(
      `ALTER TABLE ${RESOLVED_CHECKPOINTS_TABLE} ADD COLUMN followup_depth INTEGER NOT NULL DEFAULT 0`
    );
  }

  for (const statement of CHECKPOINT_STORE_INDEXES) {
    db.exec(statement);
  }
}

export function createCheckpointStore(
  db: DatabaseAdapter,
  options: CheckpointStoreOptions = {}
): CheckpointStore {
  applyCheckpointStoreMigration(db);

  const ttl_ms = resolveCheckpointStoreTtlMs(options.ttl_ms);
  const now = options.now ?? (() => Date.now());
  const putStatement = db.prepare<
    [
      string,
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      string,
      string,
      string,
      string,
      string,
      string | null,
      string,
      number,
      number,
      number
    ],
    never
  >(
    `INSERT OR REPLACE INTO ${RESOLVED_CHECKPOINTS_TABLE} (
      checkpoint_id,
      bundle_digest,
      intent,
      surface,
      session_id,
      project,
      cwd,
      query_hash,
      mode,
      profile_used,
      ranker_version,
      record_ids,
      prev_checkpoint_id,
      lineage_root_checkpoint_id,
      followup_depth,
      created_at,
      ttl_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const getStatement = db.prepare<[string], CheckpointRow>(
    `SELECT
      checkpoint_id,
      bundle_digest,
      intent,
      surface,
      session_id,
      project,
      cwd,
      query_hash,
      mode,
      profile_used,
      ranker_version,
      record_ids,
      prev_checkpoint_id,
      lineage_root_checkpoint_id,
      followup_depth,
      created_at,
      ttl_expires_at
    FROM ${RESOLVED_CHECKPOINTS_TABLE}
    WHERE checkpoint_id = ?`
  );
  const evictStatement = db.prepare<[number], never>(
    `DELETE FROM ${RESOLVED_CHECKPOINTS_TABLE} WHERE ttl_expires_at <= ?`
  );

  return {
    put(record: Omit<CheckpointRecordInput, "created_at" | "ttl_expires_at">): void {
      const created_at = now();
      const normalized = CHECKPOINT_RECORD_SCHEMA.parse({
        ...record,
        created_at,
        ttl_expires_at: created_at + ttl_ms
      });

      putStatement.run(
        normalized.checkpoint_id,
        normalized.bundle_digest,
        normalized.intent,
        normalized.surface,
        normalized.session_id,
        normalized.project,
        normalized.cwd,
        normalized.query_hash,
        normalized.mode,
        normalized.profile_used,
        normalized.ranker_version,
        JSON.stringify(normalized.record_ids),
        normalized.prev_checkpoint_id,
        normalized.lineage_root_checkpoint_id,
        normalized.followup_depth,
        normalized.created_at,
        normalized.ttl_expires_at
      );
    },
    get(checkpoint_id: string, currentNow = now()): CheckpointRecord | undefined {
      try {
        const row = getStatement.get(checkpoint_id);
        if (row === undefined || row.ttl_expires_at <= currentNow) {
          return undefined;
        }

        return toCheckpointRecord(row);
      } catch (error) {
        logger.warn("CheckpointStore.get failed to parse row", {
          checkpoint_id,
          error: error instanceof Error ? error.message : String(error)
        });
        return undefined;
      }
    },
    evictExpired(currentNow = now()): number {
      const before = db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${RESOLVED_CHECKPOINTS_TABLE} WHERE ttl_expires_at <= ?`,
        currentNow
      )?.count ?? 0;

      evictStatement.run(currentNow);
      return before;
    },
    size(): number {
      return db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${RESOLVED_CHECKPOINTS_TABLE}`
      )?.count ?? 0;
    }
  };
}
