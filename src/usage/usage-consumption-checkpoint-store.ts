import type { DatabaseAdapter } from "../db/adapter.js";
import {
  USAGE_CHECKPOINT_SCHEMA,
  type UsageCheckpoint,
  type UsageCheckpointInput
} from "../core/contracts/usage-checkpoint.js";
import { createLogger } from "../core/logging/index.js";

export interface UsageConsumptionCheckpointRecord {
  bundle_id: string;
  checkpoint_id: string;
  decision_state: UsageCheckpoint["decision_state"];
  used_items: string[];
  working_summary: string;
  submitted_at: number;
  ttl_expires_at: number;
}

export interface UsageConsumptionCheckpointStore {
  put(record: Omit<UsageCheckpointInput, "submitted_at" | "ttl_expires_at">): void;
  get(checkpoint_id: string, now?: number): UsageConsumptionCheckpointRecord | undefined;
  evictExpired(now?: number): number;
  size(): number;
}

export interface UsageConsumptionCheckpointStoreOptions {
  ttl_ms?: number;
  now?: () => number;
}

interface UsageConsumptionCheckpointRow {
  bundle_id: string;
  checkpoint_id: string;
  decision_state: string;
  used_items: string;
  working_summary: string;
  submitted_at: number;
  ttl_expires_at: number;
}

export const USAGE_CONSUMPTION_CHECKPOINTS_TABLE = "usage_consumption_checkpoints";
export const DEFAULT_USAGE_CONSUMPTION_CHECKPOINT_TTL_MS = 1_800_000;
const logger = createLogger({ name: "usage-consumption-checkpoint-store" });

const USAGE_CONSUMPTION_CHECKPOINT_STORE_DDL = `
  CREATE TABLE IF NOT EXISTS ${USAGE_CONSUMPTION_CHECKPOINTS_TABLE} (
    checkpoint_id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL,
    decision_state TEXT NOT NULL,
    used_items TEXT NOT NULL,
    working_summary TEXT NOT NULL,
    submitted_at INTEGER NOT NULL,
    ttl_expires_at INTEGER NOT NULL
  )
`;

const USAGE_CONSUMPTION_CHECKPOINT_STORE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_usage_consumption_checkpoints_ttl ON ${USAGE_CONSUMPTION_CHECKPOINTS_TABLE}(ttl_expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_consumption_checkpoints_bundle ON ${USAGE_CONSUMPTION_CHECKPOINTS_TABLE}(bundle_id, submitted_at DESC)`
] as const;

function parseUsedItems(value: string): string[] {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function toRecord(row: UsageConsumptionCheckpointRow): UsageConsumptionCheckpointRecord {
  return {
    bundle_id: row.bundle_id,
    checkpoint_id: row.checkpoint_id,
    decision_state: row.decision_state as UsageCheckpoint["decision_state"],
    used_items: parseUsedItems(row.used_items),
    working_summary: row.working_summary,
    submitted_at: row.submitted_at,
    ttl_expires_at: row.ttl_expires_at
  };
}

export function resolveUsageConsumptionCheckpointStoreTtlMs(ttl_ms?: number): number {
  if (ttl_ms !== undefined && Number.isInteger(ttl_ms) && ttl_ms > 0) {
    return ttl_ms;
  }

  const envValue = Number.parseInt(process.env.VEGA_USAGE_CONSUMPTION_CHECKPOINT_TTL_MS ?? "", 10);
  return Number.isInteger(envValue) && envValue > 0 ? envValue : DEFAULT_USAGE_CONSUMPTION_CHECKPOINT_TTL_MS;
}

export function applyUsageConsumptionCheckpointStoreMigration(db: DatabaseAdapter): void {
  db.exec(USAGE_CONSUMPTION_CHECKPOINT_STORE_DDL);

  for (const statement of USAGE_CONSUMPTION_CHECKPOINT_STORE_INDEXES) {
    db.exec(statement);
  }
}

export function createUsageConsumptionCheckpointStore(
  db: DatabaseAdapter,
  options: UsageConsumptionCheckpointStoreOptions = {}
): UsageConsumptionCheckpointStore {
  applyUsageConsumptionCheckpointStoreMigration(db);

  const ttl_ms = resolveUsageConsumptionCheckpointStoreTtlMs(options.ttl_ms);
  const now = options.now ?? (() => Date.now());

  const putStatement = db.prepare<
    [string, string, string, string, string, number, number],
    never
  >(
    `INSERT OR REPLACE INTO ${USAGE_CONSUMPTION_CHECKPOINTS_TABLE} (
      checkpoint_id,
      bundle_id,
      decision_state,
      used_items,
      working_summary,
      submitted_at,
      ttl_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const getStatement = db.prepare<[string], UsageConsumptionCheckpointRow>(
    `SELECT
      checkpoint_id,
      bundle_id,
      decision_state,
      used_items,
      working_summary,
      submitted_at,
      ttl_expires_at
    FROM ${USAGE_CONSUMPTION_CHECKPOINTS_TABLE}
    WHERE checkpoint_id = ?`
  );

  const evictStatement = db.prepare<[number], never>(
    `DELETE FROM ${USAGE_CONSUMPTION_CHECKPOINTS_TABLE} WHERE ttl_expires_at <= ?`
  );

  return {
    put(record: Omit<UsageCheckpointInput, "submitted_at" | "ttl_expires_at">): void {
      const parsed = USAGE_CHECKPOINT_SCHEMA.parse(record);
      const submitted_at = now();

      putStatement.run(
        parsed.checkpoint_id,
        parsed.bundle_id,
        parsed.decision_state,
        JSON.stringify(parsed.used_items),
        parsed.working_summary,
        submitted_at,
        submitted_at + ttl_ms
      );
    },

    get(checkpoint_id: string, currentNow = now()): UsageConsumptionCheckpointRecord | undefined {
      try {
        const row = getStatement.get(checkpoint_id);
        if (row === undefined) {
          return undefined;
        }

        const ttlExpiresAt = Number(row.ttl_expires_at);
        if (!Number.isFinite(ttlExpiresAt) || ttlExpiresAt <= currentNow) {
          return undefined;
        }

        return toRecord(row);
      } catch (error) {
        logger.warn("UsageConsumptionCheckpointStore.get failed to parse row", {
          checkpoint_id,
          error: error instanceof Error ? error.message : String(error)
        });
        return undefined;
      }
    },

    evictExpired(currentNow = now()): number {
      const before = db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${USAGE_CONSUMPTION_CHECKPOINTS_TABLE} WHERE ttl_expires_at <= ?`,
        currentNow
      )?.count ?? 0;

      evictStatement.run(currentNow);
      return before;
    },

    size(): number {
      return db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${USAGE_CONSUMPTION_CHECKPOINTS_TABLE}`
      )?.count ?? 0;
    }
  };
}
