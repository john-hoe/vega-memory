import assert from "node:assert/strict";
import test from "node:test";

import type { HostEventEnvelopeTransportV1 } from "../core/contracts/envelope.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { stageIngestEvent } from "../ingestion/pipeline.js";
import { queryRawInbox } from "../ingestion/raw-inbox.js";

const createEnvelope = (overrides: Partial<HostEventEnvelopeTransportV1> = {}): HostEventEnvelopeTransportV1 => ({
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

test("stageIngestEvent accepts a valid envelope and returns raw_inbox", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const result = stageIngestEvent(db, createEnvelope());

    assert.deepEqual(result, {
      accepted_event_id: "11111111-1111-4111-8111-111111111111",
      staged_in: "raw_inbox"
    });

    const rows = queryRawInbox(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event_id, "11111111-1111-4111-8111-111111111111");
  } finally {
    db.close();
  }
});

test("stageIngestEvent dedupes on repeated event_id", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const first = stageIngestEvent(db, createEnvelope());
    const second = stageIngestEvent(db, createEnvelope());

    assert.deepEqual(first, {
      accepted_event_id: "11111111-1111-4111-8111-111111111111",
      staged_in: "raw_inbox"
    });
    assert.deepEqual(second, {
      accepted_event_id: "11111111-1111-4111-8111-111111111111",
      staged_in: "deduped"
    });

    assert.equal(queryRawInbox(db).length, 1);
  } finally {
    db.close();
  }
});

test("stageIngestEvent preserves raw transport values in raw_inbox", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const result = stageIngestEvent(
      db,
      createEnvelope({
        event_id: "77777777-7777-4777-8777-777777777777",
        surface: "claude-code",
        role: "developer",
        event_type: "custom_event"
      })
    );

    assert.deepEqual(result, {
      accepted_event_id: "77777777-7777-4777-8777-777777777777",
      staged_in: "raw_inbox"
    });

    const rows = queryRawInbox(db, { event_id: "77777777-7777-4777-8777-777777777777" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.surface, "claude-code");
    assert.equal(rows[0]?.role, "developer");
    assert.equal(rows[0]?.event_type, "custom_event");
  } finally {
    db.close();
  }
});

test("stageIngestEvent does not store normalized_* fields in raw_inbox", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    stageIngestEvent(db, createEnvelope());

    const rows = queryRawInbox(db);
    assert.equal(rows.length, 1);
    assert.equal("normalized_surface" in (rows[0] ?? {}), false);
    assert.equal("normalized_role" in (rows[0] ?? {}), false);
    assert.equal("normalized_event_type" in (rows[0] ?? {}), false);
  } finally {
    db.close();
  }
});
