import assert from "node:assert/strict";
import test from "node:test";

import { HOST_EVENT_ENVELOPE_TRANSPORT_V1, type HostEventEnvelopeTransportV1 } from "../core/contracts/envelope.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  applyRawInboxMigration,
  insertRawEvent
} from "../ingestion/raw-inbox.js";
import { replayFromRawInbox } from "../ingestion/replay.js";

const createEnvelope = (overrides: Partial<HostEventEnvelopeTransportV1> = {}): HostEventEnvelopeTransportV1 => ({
  schema_version: "1.0",
  event_id: "33333333-3333-4333-8333-333333333333",
  surface: "cli",
  session_id: "session-a",
  thread_id: null,
  project: "vega-memory",
  cwd: null,
  host_timestamp: "2026-04-17T00:00:00.000Z",
  role: "system",
  event_type: "decision",
  payload: { title: "first" },
  safety: { redacted: false, categories: [] },
  artifacts: [],
  source_kind: "vega_memory",
  ...overrides
});

test("replayFromRawInbox returns an empty array for an empty table", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    assert.deepEqual(replayFromRawInbox(db, {}), []);
  } finally {
    db.close();
  }
});

test("replayFromRawInbox rebuilds envelopes for stored raw events", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);
    insertRawEvent(db, createEnvelope());
    insertRawEvent(
      db,
      createEnvelope({
        event_id: "44444444-4444-4444-8444-444444444444",
        session_id: "session-b",
        host_timestamp: "2026-04-17T00:01:00.000Z",
        payload: { title: "second" }
      })
    );

    const replayed = replayFromRawInbox(db, {});

    assert.equal(replayed.length, 2);
    for (const event of replayed) {
      assert.equal(HOST_EVENT_ENVELOPE_TRANSPORT_V1.safeParse(event.envelope).success, true);
      assert.equal(typeof event.received_at, "string");
      assert.equal(typeof event.replay_metadata.replayed_at, "string");
    }
  } finally {
    db.close();
  }
});

test("replay metadata carries classifier and score versions without changing order", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);
    insertRawEvent(db, createEnvelope());
    insertRawEvent(
      db,
      createEnvelope({
        event_id: "55555555-5555-4555-8555-555555555555",
        host_timestamp: "2026-04-17T00:02:00.000Z"
      })
    );

    const replayed = replayFromRawInbox(
      db,
      {},
      { classifier_version: "clf-v1", score_version: "score-v1" }
    );

    assert.deepEqual(
      replayed.map((event) => event.envelope.event_id),
      [
        "33333333-3333-4333-8333-333333333333",
        "55555555-5555-4555-8555-555555555555"
      ]
    );
    assert.deepEqual(replayed[0]?.replay_metadata, {
      replayed_at: replayed[0]?.replay_metadata.replayed_at,
      classifier_version: "clf-v1",
      score_version: "score-v1"
    });
  } finally {
    db.close();
  }
});

test("replayFromRawInbox filters by session_id", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);
    insertRawEvent(db, createEnvelope());
    insertRawEvent(
      db,
      createEnvelope({
        event_id: "66666666-6666-4666-8666-666666666666",
        session_id: "session-filtered",
        host_timestamp: "2026-04-17T00:03:00.000Z"
      })
    );

    const replayed = replayFromRawInbox(db, { session_id: "session-filtered" });

    assert.equal(replayed.length, 1);
    assert.equal(replayed[0]?.envelope.session_id, "session-filtered");
  } finally {
    db.close();
  }
});

test("replayFromRawInbox does not apply the browsing default limit unless explicitly requested", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    for (let index = 0; index < 101; index += 1) {
      insertRawEvent(
        db,
        createEnvelope({
          event_id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          host_timestamp: `2026-04-17T00:${Math.floor(index / 60)
            .toString()
            .padStart(2, "0")}:${(index % 60).toString().padStart(2, "0")}.000Z`
        })
      );
    }

    const replayed = replayFromRawInbox(db, {});
    const limited = replayFromRawInbox(db, { limit: 50 });

    assert.equal(replayed.length, 101);
    assert.equal(limited.length, 50);
  } finally {
    db.close();
  }
});

test("replayFromRawInbox preserves source_kind and artifacts from stored raw events", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);
    const envelope = createEnvelope({
      event_id: "78787878-7878-4878-8878-787878787878",
      source_kind: "host_memory_file",
      artifacts: [
        {
          id: "artifact-replay",
          kind: "transcript",
          uri: "file:///tmp/transcript.json",
          size_bytes: 42
        }
      ]
    });
    insertRawEvent(db, envelope);

    const replayed = replayFromRawInbox(db, {
      event_id: "78787878-7878-4878-8878-787878787878"
    });

    assert.equal(replayed.length, 1);
    assert.deepEqual(replayed[0]?.envelope, envelope);
  } finally {
    db.close();
  }
});
