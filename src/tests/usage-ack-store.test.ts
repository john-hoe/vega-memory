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

test("put inserts a record, normalizes nullable fields, and stamps acked_at once", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createAckStore(db, { now: () => 1_000 });
    const result = store.put(
      createAck({
        evidence: undefined,
        turn_elapsed_ms: undefined
      })
    );

    assert.equal(result.status, "inserted");
    assert.deepEqual(result.record, {
      checkpoint_id: "checkpoint-1",
      bundle_digest: "bundle-1",
      sufficiency: "sufficient",
      host_tier: "T2",
      evidence: null,
      turn_elapsed_ms: null,
      session_id: "session-1",
      acked_at: 1_000,
      guard_overridden: false
    });
    assert.deepEqual(store.get("checkpoint-1"), result.record);
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("put returns idempotent for the same checkpoint payload and preserves the first acked_at", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createAckStore(db, { now: () => now });
    const first = store.put(createAck());

    now = 1_010;
    const second = store.put(createAck());

    assert.equal(first.status, "inserted");
    assert.equal(second.status, "idempotent");
    assert.deepEqual(second.record, first.record);
    assert.equal(store.get("checkpoint-1")?.acked_at, 1_000);
    assert.equal(store.get("checkpoint-1")?.guard_overridden, false);
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("put treats same bundle and tier as idempotent even when incoming sufficiency changes", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createAckStore(db, { now: () => now });
    const first = store.put(
      createAck({
        sufficiency: "needs_followup"
      })
    );

    now = 1_010;
    const second = store.put(
      createAck({
        sufficiency: "sufficient"
      })
    );

    assert.equal(second.status, "idempotent");
    assert.deepEqual(second.record, first.record);
    assert.equal(store.get("checkpoint-1")?.sufficiency, "needs_followup");
    assert.equal(store.get("checkpoint-1")?.acked_at, 1_000);
  } finally {
    db.close();
  }
});

test("put returns conflict when the same checkpoint id changes bundle_digest", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createAckStore(db, { now: () => 1_000 });
    const first = store.put(createAck());
    const second = store.put(
      createAck({
        bundle_digest: "bundle-2"
      })
    );

    assert.equal(second.status, "conflict");
    assert.deepEqual(second.record, first.record);
    assert.equal(store.get("checkpoint-1")?.bundle_digest, "bundle-1");
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("put returns conflict when the same checkpoint id changes host_tier", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createAckStore(db, { now: () => 1_000 });
    const first = store.put(createAck());
    const second = store.put(
      createAck({
        host_tier: "T3"
      })
    );

    assert.equal(second.status, "conflict");
    assert.deepEqual(second.record, first.record);
    assert.equal(store.get("checkpoint-1")?.host_tier, "T2");
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("overrideSufficiency flips guard_overridden without changing acked_at", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createAckStore(db, { now: () => 1_000 });
    const inserted = store.put(
      createAck({
        sufficiency: "needs_followup"
      })
    );

    store.overrideSufficiency("checkpoint-1", "needs_external");

    assert.deepEqual(store.get("checkpoint-1"), {
      ...inserted.record,
      sufficiency: "needs_external",
      guard_overridden: true
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

test("countRecent filters by session, sufficiency, time window, and exclude_checkpoint_id", () => {
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
    assert.equal(
      store.countRecent({
        session_id: "session-1",
        sufficiency: "needs_followup",
        since: 0,
        exclude_checkpoint_id: "checkpoint-2"
      }),
      1
    );
  } finally {
    db.close();
  }
});

test("applyAckStoreMigration upgrades an old schema with guard_overridden defaulting to 0 and stays idempotent", () => {
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
    assert.ok(columnNames.has("guard_overridden"));

    const store = createAckStore(db, { now: () => 1_000 });
    const inserted = store.put(createAck());

    assert.equal(inserted.record.guard_overridden, false);
    assert.equal(store.get("checkpoint-1")?.guard_overridden, false);
  } finally {
    db.close();
  }
});
