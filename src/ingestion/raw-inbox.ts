import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import { HOST_EVENT_ENVELOPE_V1 } from "../core/contracts/envelope.js";
import type { DatabaseAdapter } from "../db/adapter.js";

export const RAW_INBOX_TABLE = "raw_inbox";
export const RAW_INBOX_DDL = `
  CREATE TABLE IF NOT EXISTS ${RAW_INBOX_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    event_id TEXT NOT NULL,
    surface TEXT NOT NULL,
    session_id TEXT NOT NULL,
    thread_id TEXT,
    project TEXT,
    cwd TEXT,
    host_timestamp TEXT NOT NULL,
    role TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    safety_json TEXT NOT NULL,
    received_at TEXT NOT NULL
  )
`;

export const RAW_INBOX_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS raw_inbox_event_id_uq ON ${RAW_INBOX_TABLE} (event_id)`,
  `CREATE INDEX IF NOT EXISTS raw_inbox_session_id_idx ON ${RAW_INBOX_TABLE} (session_id)`,
  `CREATE INDEX IF NOT EXISTS raw_inbox_project_idx ON ${RAW_INBOX_TABLE} (project)`,
  `CREATE INDEX IF NOT EXISTS raw_inbox_host_timestamp_idx ON ${RAW_INBOX_TABLE} (host_timestamp)`,
  `CREATE INDEX IF NOT EXISTS raw_inbox_surface_event_type_idx ON ${RAW_INBOX_TABLE} (surface, event_type)`
] as const;

export interface RawInboxRow {
  id: number;
  schema_version: string;
  event_id: string;
  surface: string;
  session_id: string;
  thread_id: string | null;
  project: string | null;
  cwd: string | null;
  host_timestamp: string;
  role: string;
  event_type: string;
  payload_json: string;
  safety_json: string;
  received_at: string;
}

export interface InsertResult {
  accepted: boolean;
  event_id: string;
  received_at: string;
  reason?: "deduped";
}

export interface RawInboxFilter {
  event_id?: string;
  session_id?: string;
  project?: string | null;
  surface?: string;
  event_type?: string;
  host_timestamp_from?: string;
  host_timestamp_to?: string;
  limit?: number;
}

interface EventIdRow {
  received_at: string;
}

const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 10_000;

const toJson = (value: unknown): string => JSON.stringify(value);

const normalizeLimit = (value?: number): number => {
  if (value === undefined) {
    return DEFAULT_QUERY_LIMIT;
  }

  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_QUERY_LIMIT;
  }

  return Math.min(value, MAX_QUERY_LIMIT);
};

export function applyRawInboxMigration(db: DatabaseAdapter): void {
  db.exec(RAW_INBOX_DDL);

  for (const statement of RAW_INBOX_INDEXES) {
    db.exec(statement);
  }
}

export function insertRawEvent(db: DatabaseAdapter, envelope: HostEventEnvelopeV1): InsertResult {
  const parsed = HOST_EVENT_ENVELOPE_V1.parse(envelope);
  const selectByEventId = db.prepare<[string], EventIdRow>(
    `SELECT received_at FROM ${RAW_INBOX_TABLE} WHERE event_id = ?`
  );
  const insertStatement = db.prepare<
    [
      string,
      string,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string,
      string,
      string,
      string,
      string,
      string
    ],
    never
  >(
    `INSERT OR IGNORE INTO ${RAW_INBOX_TABLE} (
      schema_version,
      event_id,
      surface,
      session_id,
      thread_id,
      project,
      cwd,
      host_timestamp,
      role,
      event_type,
      payload_json,
      safety_json,
      received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  return db.transaction(() => {
    const existing = selectByEventId.get(parsed.event_id);
    if (existing !== undefined) {
      return {
        accepted: false,
        event_id: parsed.event_id,
        received_at: existing.received_at,
        reason: "deduped"
      } satisfies InsertResult;
    }

    const receivedAt = new Date().toISOString();
    insertStatement.run(
      parsed.schema_version,
      parsed.event_id,
      parsed.surface,
      parsed.session_id,
      parsed.thread_id,
      parsed.project,
      parsed.cwd,
      parsed.host_timestamp,
      parsed.role,
      parsed.event_type,
      toJson(parsed.payload),
      toJson(parsed.safety),
      receivedAt
    );

    const stored = selectByEventId.get(parsed.event_id);
    if (stored === undefined || stored.received_at !== receivedAt) {
      return {
        accepted: false,
        event_id: parsed.event_id,
        received_at: stored?.received_at ?? receivedAt,
        reason: "deduped"
      } satisfies InsertResult;
    }

    return {
      accepted: true,
      event_id: parsed.event_id,
      received_at: receivedAt
    } satisfies InsertResult;
  });
}

export function queryRawInbox(
  db: DatabaseAdapter,
  filter: RawInboxFilter = {}
): RawInboxRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.event_id !== undefined) {
    clauses.push("event_id = ?");
    params.push(filter.event_id);
  }

  if (filter.session_id !== undefined) {
    clauses.push("session_id = ?");
    params.push(filter.session_id);
  }

  if (filter.project === null) {
    clauses.push("project IS NULL");
  } else if (filter.project !== undefined) {
    clauses.push("project = ?");
    params.push(filter.project);
  }

  if (filter.surface !== undefined) {
    clauses.push("surface = ?");
    params.push(filter.surface);
  }

  if (filter.event_type !== undefined) {
    clauses.push("event_type = ?");
    params.push(filter.event_type);
  }

  if (filter.host_timestamp_from !== undefined) {
    clauses.push("host_timestamp >= ?");
    params.push(filter.host_timestamp_from);
  }

  if (filter.host_timestamp_to !== undefined) {
    clauses.push("host_timestamp <= ?");
    params.push(filter.host_timestamp_to);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = normalizeLimit(filter.limit);
  const statement = db.prepare<unknown[], RawInboxRow>(
    `SELECT
       id,
       schema_version,
       event_id,
       surface,
       session_id,
       thread_id,
       project,
       cwd,
       host_timestamp,
       role,
       event_type,
       payload_json,
       safety_json,
       received_at
     FROM ${RAW_INBOX_TABLE}
     ${where}
     ORDER BY host_timestamp ASC, id ASC
     LIMIT ?`
  );

  return statement.all(...params, limit);
}
