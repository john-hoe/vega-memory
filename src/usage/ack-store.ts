import type { HostTier, Sufficiency } from "../core/contracts/enums.js";
import type { DatabaseAdapter } from "../db/adapter.js";

export interface AckRecord {
  checkpoint_id: string;
  bundle_digest: string;
  sufficiency: Sufficiency;
  host_tier: HostTier;
  evidence: string | null;
  turn_elapsed_ms: number | null;
  acked_at: number;
}

export interface AckStore {
  put(ack: Omit<AckRecord, "acked_at">): AckRecord;
  get(checkpoint_id: string): AckRecord | undefined;
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
  acked_at: number;
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
    acked_at INTEGER NOT NULL
  )
`;

const ACK_STORE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_usage_acks_sufficiency ON ${USAGE_ACKS_TABLE}(sufficiency, acked_at DESC)`
] as const;

export function applyAckStoreMigration(db: DatabaseAdapter): void {
  db.exec(ACK_STORE_DDL);

  for (const statement of ACK_STORE_INDEXES) {
    db.exec(statement);
  }
}

export function createAckStore(
  db: DatabaseAdapter,
  options: AckStoreOptions = {}
): AckStore {
  applyAckStoreMigration(db);

  const now = options.now ?? (() => Date.now());
  const putStatement = db.prepare<
    [string, string, Sufficiency, HostTier, string | null, number | null, number],
    never
  >(
    `INSERT OR REPLACE INTO ${USAGE_ACKS_TABLE} (
      checkpoint_id,
      bundle_digest,
      sufficiency,
      host_tier,
      evidence,
      turn_elapsed_ms,
      acked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const getStatement = db.prepare<[string], AckRow>(
    `SELECT
      checkpoint_id,
      bundle_digest,
      sufficiency,
      host_tier,
      evidence,
      turn_elapsed_ms,
      acked_at
    FROM ${USAGE_ACKS_TABLE}
    WHERE checkpoint_id = ?`
  );

  return {
    put(ack: Omit<AckRecord, "acked_at">): AckRecord {
      const stored: AckRecord = {
        ...ack,
        evidence: ack.evidence ?? null,
        turn_elapsed_ms: ack.turn_elapsed_ms ?? null,
        acked_at: now()
      };

      putStatement.run(
        stored.checkpoint_id,
        stored.bundle_digest,
        stored.sufficiency,
        stored.host_tier,
        stored.evidence,
        stored.turn_elapsed_ms,
        stored.acked_at
      );

      return stored;
    },
    get(checkpoint_id: string): AckRecord | undefined {
      return getStatement.get(checkpoint_id);
    },
    size(): number {
      return db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${USAGE_ACKS_TABLE}`
      )?.count ?? 0;
    }
  };
}
