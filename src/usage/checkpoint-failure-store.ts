import { v4 as uuidv4 } from "uuid";

import type { Intent, Mode, Surface } from "../core/contracts/enums.js";
import type { DatabaseAdapter } from "../db/adapter.js";

export interface CheckpointFailureRecord {
  id: string;
  checkpoint_id: string;
  reason: string;
  intent: Intent;
  surface: Surface;
  session_id: string;
  project: string | null;
  cwd: string | null;
  query_hash: string;
  mode: Mode;
  profile_used: string;
  ranker_version: string;
  payload: string;
  occurred_at: number;
}

export interface CheckpointFailureStore {
  put(
    record: Omit<CheckpointFailureRecord, "id" | "occurred_at">
  ): CheckpointFailureRecord;
  listRecent(limit?: number): CheckpointFailureRecord[];
  size(): number;
}

export interface CheckpointFailureStoreOptions {
  now?: () => number;
  idFactory?: () => string;
}

interface CheckpointFailureRow extends CheckpointFailureRecord {}

const CHECKPOINT_FAILURES_TABLE = "checkpoint_failures";
const DEFAULT_LIST_LIMIT = 100;
const CHECKPOINT_FAILURES_DDL = `
  CREATE TABLE IF NOT EXISTS ${CHECKPOINT_FAILURES_TABLE} (
    id TEXT PRIMARY KEY,
    checkpoint_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    intent TEXT NOT NULL,
    surface TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project TEXT,
    cwd TEXT,
    query_hash TEXT NOT NULL,
    mode TEXT NOT NULL,
    profile_used TEXT NOT NULL,
    ranker_version TEXT NOT NULL,
    payload TEXT NOT NULL,
    occurred_at INTEGER NOT NULL
  )
`;
const CHECKPOINT_FAILURES_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_checkpoint_failures_occurred ON ${CHECKPOINT_FAILURES_TABLE}(occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_checkpoint_failures_session ON ${CHECKPOINT_FAILURES_TABLE}(session_id, occurred_at DESC)`
] as const;

function normalizeLimit(limit?: number): number {
  return limit !== undefined && Number.isInteger(limit) && limit > 0
    ? limit
    : DEFAULT_LIST_LIMIT;
}

export function applyCheckpointFailureStoreMigration(db: DatabaseAdapter): void {
  db.exec(CHECKPOINT_FAILURES_DDL);

  for (const statement of CHECKPOINT_FAILURES_INDEXES) {
    db.exec(statement);
  }
}

export function createCheckpointFailureStore(
  db: DatabaseAdapter,
  options: CheckpointFailureStoreOptions = {}
): CheckpointFailureStore {
  applyCheckpointFailureStoreMigration(db);

  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? uuidv4;
  const putStatement = db.prepare<
    [
      string,
      string,
      string,
      Intent,
      Surface,
      string,
      string | null,
      string | null,
      string,
      Mode,
      string,
      string,
      string,
      number
    ],
    never
  >(
    `INSERT INTO ${CHECKPOINT_FAILURES_TABLE} (
      id,
      checkpoint_id,
      reason,
      intent,
      surface,
      session_id,
      project,
      cwd,
      query_hash,
      mode,
      profile_used,
      ranker_version,
      payload,
      occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const listStatement = db.prepare<[number], CheckpointFailureRow>(
    `SELECT
      id,
      checkpoint_id,
      reason,
      intent,
      surface,
      session_id,
      project,
      cwd,
      query_hash,
      mode,
      profile_used,
      ranker_version,
      payload,
      occurred_at
    FROM ${CHECKPOINT_FAILURES_TABLE}
    ORDER BY occurred_at DESC
    LIMIT ?`
  );

  return {
    put(record: Omit<CheckpointFailureRecord, "id" | "occurred_at">): CheckpointFailureRecord {
      const stored: CheckpointFailureRecord = {
        ...record,
        id: idFactory(),
        occurred_at: now()
      };

      putStatement.run(
        stored.id,
        stored.checkpoint_id,
        stored.reason,
        stored.intent,
        stored.surface,
        stored.session_id,
        stored.project,
        stored.cwd,
        stored.query_hash,
        stored.mode,
        stored.profile_used,
        stored.ranker_version,
        stored.payload,
        stored.occurred_at
      );

      return stored;
    },
    listRecent(limit?: number): CheckpointFailureRecord[] {
      return listStatement.all(normalizeLimit(limit));
    },
    size(): number {
      return db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${CHECKPOINT_FAILURES_TABLE}`
      )?.count ?? 0;
    }
  };
}
