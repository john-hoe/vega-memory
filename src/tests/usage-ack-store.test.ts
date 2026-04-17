import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  applyAckStoreMigration,
  createAckStore
} from "../usage/index.js";

interface TableInfoRow {
  name: string;
}

const createAck = (
  overrides: Partial<{
    checkpoint_id: string;
    bundle_digest: string;
    sufficiency: "sufficient" | "needs_followup" | "needs_external";
    host_tier: "T1" | "T2" | "T3";
    evidence?: string;
    turn_elapsed_ms?: number;
    session_id?: string | null;
  }> = {}
) => ({
  checkpoint_id: "checkpoint-1",
  bundle_digest: "bundle-1",
  sufficiency: "sufficient" as const,
  host_tier: "T2" as const,
  evidence: "enough evidence",
  turn_elapsed_ms: 125,
  session_id: "session-1",
  ...overrides
});

test("put and get round-trip an ack record and stamp acked_at", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createAckStore(db, { now: () => 1_000 });
    const saved = store.put(createAck());

    assert.equal(saved.acked_at, 1_000);
    assert.deepEqual(store.get("checkpoint-1"), saved);
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("put overwrites the prior payload for the same checkpoint id", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createAckStore(db, { now: () => now });

    store.put(createAck());
    now = 1_010;
    store.put(
      createAck({
        checkpoint_id: "checkpoint-1",
        bundle_digest: "bundle-2",
        sufficiency: "needs_followup"
      })
    );

    assert.deepEqual(store.get("checkpoint-1"), {
      checkpoint_id: "checkpoint-1",
      bundle_digest: "bundle-2",
      sufficiency: "needs_followup",
      host_tier: "T2",
      evidence: "enough evidence",
      turn_elapsed_ms: 125,
      session_id: "session-1",
      acked_at: 1_010
    });
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("put stores nullable evidence and turn_elapsed_ms when omitted", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createAckStore(db, { now: () => 1_000 });
    store.put(
      createAck({
        evidence: undefined,
        turn_elapsed_ms: undefined
      })
    );

    assert.deepEqual(store.get("checkpoint-1"), {
      checkpoint_id: "checkpoint-1",
      bundle_digest: "bundle-1",
      sufficiency: "sufficient",
      host_tier: "T2",
      evidence: null,
      turn_elapsed_ms: null,
      session_id: "session-1",
      acked_at: 1_000
    });
  } finally {
    db.close();
  }
});

test("get returns undefined for unknown checkpoint ids", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createAckStore(db);

    assert.equal(store.get("missing-checkpoint"), undefined);
  } finally {
    db.close();
  }
});

test("applyAckStoreMigration is idempotent", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    assert.doesNotThrow(() => applyAckStoreMigration(db));
    assert.doesNotThrow(() => applyAckStoreMigration(db));
  } finally {
    db.close();
  }
});

test("countRecent filters by session_id, sufficiency, and since", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createAckStore(db, { now: () => now });

    store.put(createAck({ checkpoint_id: "checkpoint-1", sufficiency: "needs_followup" }));
    now = 1_050;
    store.put(createAck({ checkpoint_id: "checkpoint-2", sufficiency: "needs_followup" }));
    now = 1_100;
    store.put(
      createAck({
        checkpoint_id: "checkpoint-3",
        sufficiency: "needs_followup",
        session_id: "session-2"
      })
    );
    now = 1_150;
    store.put(createAck({ checkpoint_id: "checkpoint-4", sufficiency: "sufficient" }));

    assert.equal(
      store.countRecent({
        session_id: "session-1",
        sufficiency: "needs_followup",
        since: 1_025
      }),
      1
    );
    assert.equal(
      store.countRecent({
        session_id: "session-2",
        sufficiency: "needs_followup",
        since: 0
      }),
      1
    );
    assert.equal(
      store.countRecent({
        session_id: "session-1",
        sufficiency: "sufficient",
        since: 0
      }),
      1
    );
  } finally {
    db.close();
  }
});

test("applyAckStoreMigration upgrades the 7b schema and remains idempotent", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    db.exec(`
      CREATE TABLE usage_acks (
        checkpoint_id TEXT PRIMARY KEY,
        bundle_digest TEXT NOT NULL,
        sufficiency TEXT NOT NULL,
        host_tier TEXT NOT NULL,
        evidence TEXT,
        turn_elapsed_ms INTEGER,
        acked_at INTEGER NOT NULL
      )
    `);

    assert.doesNotThrow(() => applyAckStoreMigration(db));
    assert.doesNotThrow(() => applyAckStoreMigration(db));

    const columnNames = new Set(
      db
        .prepare<[], TableInfoRow>("PRAGMA table_info(usage_acks)")
        .all()
        .map((column) => column.name)
    );

    assert.ok(columnNames.has("session_id"));
  } finally {
    db.close();
  }
});
