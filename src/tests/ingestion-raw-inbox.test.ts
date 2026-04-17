import assert from "node:assert/strict";
import test from "node:test";

import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  applyRawInboxMigration,
  insertRawEvent,
  queryRawInbox,
  RAW_INBOX_INDEXES,
  RAW_INBOX_TABLE
} from "../ingestion/raw-inbox.js";

const createEnvelope = (overrides: Partial<HostEventEnvelopeV1> = {}): HostEventEnvelopeV1 => ({
  schema_version: "1.0",
  event_id: "11111111-1111-4111-8111-111111111111",
  surface: "codex",
  session_id: "session-1",
  thread_id: "thread-1",
  project: "vega-memory",
  cwd: "/workspace/vega-memory",
  host_timestamp: "2026-04-17T00:00:00.000Z",
  role: "assistant",
  event_type: "message",
  payload: { text: "hello" },
  safety: { redacted: false, categories: [] },
  artifacts: [],
  source_kind: "vega_memory",
  ...overrides
});

test("applyRawInboxMigration is idempotent", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    assert.doesNotThrow(() => applyRawInboxMigration(db));
    assert.doesNotThrow(() => applyRawInboxMigration(db));

    const table = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      RAW_INBOX_TABLE
    );

    assert.equal(table?.name, RAW_INBOX_TABLE);
    assert.equal(RAW_INBOX_INDEXES.length >= 4, true);
  } finally {
    db.close();
  }
});

test("applyRawInboxMigration additively upgrades legacy raw_inbox tables", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    db.exec(`
      CREATE TABLE raw_inbox (
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
    `);

    applyRawInboxMigration(db);

    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info(raw_inbox)")
      .all()
      .map((column) => column.name);

    assert.deepEqual(columns.includes("source_kind"), true);
    assert.deepEqual(columns.includes("artifacts_json"), true);

    const result = insertRawEvent(
      db,
      createEnvelope({
        event_id: "99999999-9999-4999-8999-999999999999",
        source_kind: "host_memory_file",
        artifacts: [
          {
            id: "artifact-upgrade",
            kind: "log",
            uri: "file:///tmp/upgrade.log"
          }
        ]
      })
    );

    assert.equal(result.accepted, true);
    assert.equal(
      queryRawInbox(db, { event_id: "99999999-9999-4999-8999-999999999999" }).length,
      1
    );
  } finally {
    db.close();
  }
});

test("insertRawEvent accepts a valid envelope", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const result = insertRawEvent(db, createEnvelope());
    const rows = queryRawInbox(db);

    assert.equal(result.accepted, true);
    assert.equal(result.event_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(typeof result.received_at, "string");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event_id, result.event_id);
  } finally {
    db.close();
  }
});

test("insertRawEvent dedupes duplicate event_id values", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const first = insertRawEvent(db, createEnvelope());
    const second = insertRawEvent(db, createEnvelope());

    assert.equal(first.accepted, true);
    assert.deepEqual(second, {
      accepted: false,
      event_id: "11111111-1111-4111-8111-111111111111",
      received_at: first.received_at,
      reason: "deduped"
    });
    assert.equal(queryRawInbox(db).length, 1);
  } finally {
    db.close();
  }
});

test("queryRawInbox filters by session_id", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    insertRawEvent(db, createEnvelope());
    insertRawEvent(
      db,
      createEnvelope({
        event_id: "22222222-2222-4222-8222-222222222222",
        session_id: "session-2"
      })
    );

    const rows = queryRawInbox(db, { session_id: "session-2" });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event_id, "22222222-2222-4222-8222-222222222222");
  } finally {
    db.close();
  }
});

test("insertRawEvent and queryRawInbox preserve source_kind and artifacts payloads", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    insertRawEvent(
      db,
      createEnvelope({
        event_id: "12121212-1212-4212-8212-121212121212",
        source_kind: "host_memory_file",
        artifacts: [
          {
            id: "artifact-1",
            kind: "log",
            uri: "file:///tmp/artifact.log",
            size_bytes: 128
          }
        ]
      })
    );

    const rows = queryRawInbox(db, {
      event_id: "12121212-1212-4212-8212-121212121212"
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source_kind, "host_memory_file");
    assert.equal(
      rows[0]?.artifacts_json,
      JSON.stringify([
        {
          id: "artifact-1",
          kind: "log",
          uri: "file:///tmp/artifact.log",
          size_bytes: 128
        }
      ])
    );
  } finally {
    db.close();
  }
});

test("insertRawEvent throws when the envelope fails schema validation", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    assert.throws(
      () =>
        insertRawEvent(
          db,
          createEnvelope({
            surface: "invalid-surface" as never
          })
        ),
      /surface/i
    );
  } finally {
    db.close();
  }
});
