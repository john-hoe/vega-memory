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
