import { v4 as uuidv4, validate as isUuid } from "uuid";

import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import { HOST_EVENT_ENVELOPE_V1 } from "../core/contracts/envelope.js";
import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { applyRawInboxMigration, insertRawEvent } from "./raw-inbox.js";

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

interface ParsedSourceContext {
  session_id?: string;
}

const logger = createLogger({ name: "raw-inbox-backfill" });

const parseJson = (value: string | null): unknown => {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const parseSourceContext = (value: string | null): ParsedSourceContext | null => {
  if (value === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    return parsed as ParsedSourceContext;
  } catch {
    return null;
  }
};

const normalizeLimit = (value?: number): number => {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return 10_000;
  }

  return value;
};

const mapMemoryToEnvelope = (
  memory: MemoryBackfillRow,
  defaultSurface: string
): HostEventEnvelopeV1 => {
  const sourceContext = parseSourceContext(memory.source_context);

  return {
    schema_version: "1.0",
    event_id: isUuid(memory.id) ? memory.id : uuidv4(),
    surface: defaultSurface as HostEventEnvelopeV1["surface"],
    session_id: sourceContext?.session_id ?? `legacy-${memory.id}`,
    thread_id: null,
    project: memory.project ?? null,
    cwd: null,
    host_timestamp: memory.created_at,
    role: "system",
    event_type: "decision",
    payload: {
      memory_type: memory.type,
      title: memory.title,
      content: memory.content,
      summary: memory.summary,
      tags: parseJson(memory.tags)
    },
    safety: {
      redacted: false,
      categories: []
    },
    artifacts: [],
    source_kind: "vega_memory"
  };
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
    const envelope = mapMemoryToEnvelope(row, defaultSurface);
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
