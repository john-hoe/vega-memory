import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import { HOST_EVENT_ENVELOPE_V1 } from "../core/contracts/envelope.js";
import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { memoryToEnvelope } from "./memory-to-envelope.js";
import { applyRawInboxMigration, insertRawEvent } from "./raw-inbox.js";

export { VEGA_BACKFILL_NAMESPACE } from "./memory-to-envelope.js";

export interface BackfillOptions {
  since?: string;
  until?: string;
  project?: string;
  limit?: number;
  default_surface?: string;
  dry_run?: boolean;
}

export interface BackfillResult {
  scanned: number;
  mapped: number;
  skipped: number;
  inserted: number;
  deduped: number;
}

interface MemoryBackfillRow {
  id: string;
  type: string;
  project: string | null;
  title: string;
  content: string;
  summary: string | null;
  tags: string;
  created_at: string;
  source_context: string | null;
}

const logger = createLogger({ name: "raw-inbox-backfill" });

const normalizeLimit = (value?: number): number => {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return 10_000;
  }

  return value;
};

export function backfillMemoriesToRawInbox(
  db: DatabaseAdapter,
  options: BackfillOptions = {}
): BackfillResult {
  applyRawInboxMigration(db);

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.since !== undefined) {
    clauses.push("created_at >= ?");
    params.push(options.since);
  }

  if (options.until !== undefined) {
    clauses.push("created_at <= ?");
    params.push(options.until);
  }

  if (options.project !== undefined) {
    clauses.push("project = ?");
    params.push(options.project);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = normalizeLimit(options.limit);
  const statement = db.prepare<unknown[], MemoryBackfillRow>(
    `SELECT
       id,
       type,
       project,
       title,
       content,
       summary,
       tags,
       created_at,
       source_context
     FROM memories
     ${where}
     ORDER BY created_at ASC, id ASC
     LIMIT ?`
  );
  const rows = statement.all(...params, limit);
  const result: BackfillResult = {
    scanned: rows.length,
    mapped: 0,
    skipped: 0,
    inserted: 0,
    deduped: 0
  };
  const defaultSurface = options.default_surface ?? "api";

  for (const row of rows) {
    const envelope = memoryToEnvelope(row, {
      default_surface: defaultSurface
    });
    const parsed = HOST_EVENT_ENVELOPE_V1.safeParse(envelope);

    if (!parsed.success) {
      result.skipped += 1;
      logger.warn("Skipping memory during raw inbox backfill", {
        memory_id: row.id,
        issue: parsed.error.issues.map((issue) => issue.message).join("; ")
      });
      continue;
    }

    result.mapped += 1;

    if (options.dry_run) {
      continue;
    }

    const insertResult = insertRawEvent(db, parsed.data);
    if (insertResult.accepted) {
      result.inserted += 1;
    } else {
      result.deduped += 1;
    }
  }

  return result;
}
