import { createLogger, type Logger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";

const logger = createLogger({ name: "timeout-detector" });
const CHECKPOINT_TABLE_CANDIDATES = ["checkpoints", "resolved_checkpoints"] as const;
const DETECTED_TIMEOUT_TIERS = new Set(["T1", "T2", "T3"]);

interface TableInfoRow {
  name: string;
}

interface RawDetectedTimeoutRow {
  checkpoint_id: string;
  created_at: number;
  ttl_ms: number;
  expires_at: number;
  host_tier: string | null;
  surface: string | null;
  intent: string | null;
  session_id: string | null;
  project: string | null;
  cwd: string | null;
  query_hash: string | null;
  mode: string | null;
  profile_used: string | null;
  ranker_version: string | null;
}

export interface DetectedTimeout {
  checkpoint_id: string;
  created_at: number;
  ttl_ms: number;
  expires_at: number;
  host_tier: "T1" | "T2" | "T3" | "unknown";
  surface?: string;
  intent?: string;
  session_id?: string | null;
  project?: string | null;
  cwd?: string | null;
  query_hash?: string | null;
  mode?: string | null;
  profile_used?: string | null;
  ranker_version?: string | null;
}

export interface DetectExpiredCheckpointsOptions {
  now: number;
  maxPerRun: number;
  logger?: Logger;
}

export interface DetectExpiredCheckpointsResult {
  records: DetectedTimeout[];
  degraded?: "schema_incompatible" | "sqlite_only";
}

const coerceHostTier = (
  value: string | null | undefined
): DetectedTimeout["host_tier"] =>
  value !== null && value !== undefined && DETECTED_TIMEOUT_TIERS.has(value)
    ? (value as DetectedTimeout["host_tier"])
    : "unknown";

const getTableColumns = (db: DatabaseAdapter, table: string): string[] => {
  if (db.isPostgres) {
    return [];
  }

  try {
    return db
      .prepare<[], TableInfoRow>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
  } catch {
    return [];
  }
};

const findCheckpointTable = (
  db: DatabaseAdapter
):
  | {
      table: string;
      columns: Set<string>;
    }
  | undefined => {
  for (const table of CHECKPOINT_TABLE_CANDIDATES) {
    const columns = new Set(getTableColumns(db, table));
    if (columns.has("checkpoint_id")) {
      return {
        table,
        columns
      };
    }
  }

  return undefined;
};

const toSqlProjection = (columns: Set<string>, column: string, fallback = "NULL"): string =>
  columns.has(column) ? column : `${fallback}`;

export function inspectExpiredCheckpoints(
  db: DatabaseAdapter,
  options: DetectExpiredCheckpointsOptions
): DetectExpiredCheckpointsResult {
  const activeLogger = options.logger ?? logger;

  if (db.isPostgres) {
    return {
      records: [],
      degraded: "sqlite_only"
    };
  }

  try {
    const checkpointTable = findCheckpointTable(db);
    if (checkpointTable === undefined) {
      activeLogger.warn("Timeout detector schema incompatible.", {
        reason: "schema_incompatible",
        missing: ["checkpoint table"]
      });
      return {
        records: [],
        degraded: "schema_incompatible"
      };
    }

    const expiresColumn = checkpointTable.columns.has("expires_at")
      ? "expires_at"
      : checkpointTable.columns.has("ttl_expires_at")
        ? "ttl_expires_at"
        : undefined;
    const ttlExpression =
      checkpointTable.columns.has("ttl_ms") && expiresColumn !== undefined
        ? "ttl_ms"
        : expiresColumn !== undefined && checkpointTable.columns.has("created_at")
          ? `CASE
              WHEN ${expiresColumn} > created_at THEN ${expiresColumn} - created_at
              ELSE 0
            END`
          : undefined;
    const requiredColumns = [
      checkpointTable.columns.has("created_at") ? "created_at" : undefined,
      expiresColumn,
      ttlExpression,
      checkpointTable.columns.has("host_tier") ? "host_tier" : undefined
    ].filter((value): value is string => value !== undefined);

    if (requiredColumns.length < 4) {
      activeLogger.warn("Timeout detector schema incompatible.", {
        reason: "schema_incompatible",
        table: checkpointTable.table,
        columns: [...checkpointTable.columns].sort()
      });
      return {
        records: [],
        degraded: "schema_incompatible"
      };
    }

    const unresolvedPredicate = checkpointTable.columns.has("resolved_at")
      ? "resolved_at IS NULL"
      : checkpointTable.columns.has("status")
        ? `(status IS NULL OR status != 'expired')`
        : "1 = 1";
    const rows = db.prepare<[number, number], RawDetectedTimeoutRow>(
      `SELECT
        checkpoint_id,
        created_at,
        ${ttlExpression} AS ttl_ms,
        ${expiresColumn} AS expires_at,
        host_tier,
        ${toSqlProjection(checkpointTable.columns, "surface")} AS surface,
        ${toSqlProjection(checkpointTable.columns, "intent")} AS intent,
        ${toSqlProjection(checkpointTable.columns, "session_id")} AS session_id,
        ${toSqlProjection(checkpointTable.columns, "project")} AS project,
        ${toSqlProjection(checkpointTable.columns, "cwd")} AS cwd,
        ${toSqlProjection(checkpointTable.columns, "query_hash")} AS query_hash,
        ${toSqlProjection(checkpointTable.columns, "mode")} AS mode,
        ${toSqlProjection(checkpointTable.columns, "profile_used")} AS profile_used,
        ${toSqlProjection(checkpointTable.columns, "ranker_version")} AS ranker_version
      FROM ${checkpointTable.table}
      WHERE ${expiresColumn} < ?
        AND ${unresolvedPredicate}
      ORDER BY ${expiresColumn} ASC
      LIMIT ?`
    ).all(options.now, options.maxPerRun);

    return {
      records: rows.map((row) => ({
        checkpoint_id: row.checkpoint_id,
        created_at: row.created_at,
        ttl_ms: row.ttl_ms,
        expires_at: row.expires_at,
        host_tier: coerceHostTier(row.host_tier),
        ...(row.surface === null ? {} : { surface: row.surface }),
        ...(row.intent === null ? {} : { intent: row.intent }),
        session_id: row.session_id,
        project: row.project,
        cwd: row.cwd,
        query_hash: row.query_hash,
        mode: row.mode,
        profile_used: row.profile_used,
        ranker_version: row.ranker_version
      }))
    };
  } catch (error) {
    activeLogger.warn("Timeout detector failed.", {
      reason: "schema_incompatible",
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      records: [],
      degraded: "schema_incompatible"
    };
  }
}

export function detectExpiredCheckpoints(
  db: DatabaseAdapter,
  options: DetectExpiredCheckpointsOptions
): DetectedTimeout[] {
  return inspectExpiredCheckpoints(db, options).records;
}
