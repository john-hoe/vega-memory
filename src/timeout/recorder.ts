import { randomUUID } from "node:crypto";

import { createLogger, type Logger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";

import type { TimeoutPolicyDecision } from "./policy.js";

const logger = createLogger({ name: "timeout-recorder" });
const CHECKPOINT_TABLE_CANDIDATES = ["checkpoints", "resolved_checkpoints"] as const;

interface TableInfoRow {
  name: string;
}

export interface RecordTimeoutFailureInput {
  checkpoint_id: string;
  decision: TimeoutPolicyDecision["decision"];
  reason: string;
  detected_at: number;
  intent?: string | null;
  surface?: string | null;
  session_id?: string | null;
  project?: string | null;
  cwd?: string | null;
  query_hash?: string | null;
  mode?: string | null;
  profile_used?: string | null;
  ranker_version?: string | null;
  expires_at?: number;
  host_tier?: string;
  logger?: Logger;
}

export interface TimeoutSweepRecorderResult {
  written: boolean;
  reason: string;
}

const getTableColumns = (db: DatabaseAdapter, table: string): string[] => {
  try {
    return db
      .prepare<[], TableInfoRow>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
  } catch {
    return [];
  }
};

const insertRow = (
  db: DatabaseAdapter,
  columns: readonly string[],
  values: readonly unknown[]
): void => {
  const placeholders = columns.map(() => "?").join(", ");
  db.run(
    `INSERT INTO checkpoint_failures (${columns.join(", ")}) VALUES (${placeholders})`,
    ...values
  );
};

const updateCheckpointStatus = (
  db: DatabaseAdapter,
  checkpointId: string
): boolean => {
  for (const table of CHECKPOINT_TABLE_CANDIDATES) {
    const columns = new Set(getTableColumns(db, table));
    if (!columns.has("checkpoint_id") || !columns.has("status")) {
      continue;
    }

    db.run(
      `UPDATE ${table}
      SET status = ?
      WHERE checkpoint_id = ?`,
      "expired_degraded",
      checkpointId
    );
    return true;
  }

  return false;
};

export function recordTimeoutFailure(
  db: DatabaseAdapter,
  input: RecordTimeoutFailureInput
): TimeoutSweepRecorderResult {
  const activeLogger = input.logger ?? logger;

  if (db.isPostgres) {
    return {
      written: false,
      reason: "sqlite_only"
    };
  } else {
    try {
      if (input.decision === "presumed_sufficient") {
        const updated = updateCheckpointStatus(db, input.checkpoint_id);

        if (!updated) {
          activeLogger.debug("Timeout recorder skipped checkpoint status update.", {
            checkpoint_id: input.checkpoint_id,
            reason: "status_column_missing"
          });
        }

        return {
          written: false,
          reason: "presumed_sufficient"
        };
      }

      const columns = new Set(getTableColumns(db, "checkpoint_failures"));
      if (columns.size === 0) {
        activeLogger.warn("Timeout recorder missing checkpoint_failures table.", {
          checkpoint_id: input.checkpoint_id
        });
        return {
          written: false,
          reason: "table_missing"
        };
      }

      const richColumns = [
        "id",
        "checkpoint_id",
        "reason",
        "intent",
        "surface",
        "session_id",
        "project",
        "cwd",
        "query_hash",
        "mode",
        "profile_used",
        "ranker_version",
        "payload",
        "occurred_at"
      ] as const;
      if (richColumns.every((column) => columns.has(column))) {
        insertRow(db, richColumns, [
          randomUUID(),
          input.checkpoint_id,
          input.reason,
          input.intent ?? "lookup",
          input.surface ?? "api",
          input.session_id ?? "timeout-sweep",
          input.project ?? null,
          input.cwd ?? null,
          input.query_hash ?? `timeout:${input.checkpoint_id}`,
          input.mode ?? "L1",
          input.profile_used ?? "timeout-sweep",
          input.ranker_version ?? "timeout-policy",
          JSON.stringify({
            category: "l1_ttl_expired",
            detected_at: input.detected_at,
            expires_at: input.expires_at ?? null,
            host_tier: input.host_tier ?? "unknown"
          }),
          input.detected_at
        ]);

        return {
          written: true,
          reason: "inserted"
        };
      }

      if (
        ["id", "checkpoint_id", "reason", "category", "created_at"].every((column) =>
          columns.has(column)
        )
      ) {
        insertRow(db, ["id", "checkpoint_id", "reason", "category", "created_at"], [
          randomUUID(),
          input.checkpoint_id,
          input.reason,
          "l1_ttl_expired",
          input.detected_at
        ]);

        return {
          written: true,
          reason: "inserted"
        };
      }

      if (
        ["id", "checkpoint_id", "reason", "created_at"].every((column) => columns.has(column))
      ) {
        insertRow(db, ["id", "checkpoint_id", "reason", "created_at"], [
          randomUUID(),
          input.checkpoint_id,
          input.reason,
          input.detected_at
        ]);

        activeLogger.warn("Timeout recorder used minimal fallback insert.", {
          checkpoint_id: input.checkpoint_id
        });

        return {
          written: true,
          reason: "inserted"
        };
      }

      if (
        ["id", "checkpoint_id", "reason", "category", "occurred_at"].every((column) =>
          columns.has(column)
        )
      ) {
        insertRow(db, ["id", "checkpoint_id", "reason", "category", "occurred_at"], [
          randomUUID(),
          input.checkpoint_id,
          input.reason,
          "l1_ttl_expired",
          input.detected_at
        ]);

        return {
          written: true,
          reason: "inserted"
        };
      }

      if (
        ["id", "checkpoint_id", "reason", "occurred_at"].every((column) => columns.has(column))
      ) {
        insertRow(db, ["id", "checkpoint_id", "reason", "occurred_at"], [
          randomUUID(),
          input.checkpoint_id,
          input.reason,
          input.detected_at
        ]);

        activeLogger.warn("Timeout recorder used minimal occurred_at fallback insert.", {
          checkpoint_id: input.checkpoint_id
        });

        return {
          written: true,
          reason: "inserted"
        };
      }

      activeLogger.warn("Timeout recorder found incompatible checkpoint_failures schema.", {
        checkpoint_id: input.checkpoint_id,
        columns: [...columns].sort()
      });
      return {
        written: false,
        reason: "schema_incompatible"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      activeLogger.warn("Timeout recorder failed.", {
        checkpoint_id: input.checkpoint_id,
        error: message
      });
      return {
        written: false,
        reason: message
      };
    }
  }
}
