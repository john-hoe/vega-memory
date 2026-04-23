import assert from "node:assert/strict";
import test from "node:test";

import type { CheckpointRecord } from "../core/contracts/index.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { RESOLVED_CHECKPOINTS_TABLE } from "../usage/checkpoint-store.js";
import {
  applyCheckpointStoreMigration,
  createCheckpointStore
} from "../usage/index.js";

type PendingCheckpointRecord = Omit<CheckpointRecord, "created_at" | "ttl_expires_at">;

function createCheckpointRecord(
  overrides: Partial<PendingCheckpointRecord> = {}
): PendingCheckpointRecord {
  return {
    checkpoint_id: "checkpoint-1",
    bundle_digest: "bundle-1",
    intent: "lookup",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    query_hash: "query-hash-1",
    mode: "L1",
    profile_used: "lookup",
    ranker_version: "v1.0",
    record_ids: ["wiki:wiki-1", "vega_memory:mem-1"],
    prev_checkpoint_id: null,
    lineage_root_checkpoint_id: "checkpoint-1",
    followup_depth: 0,
    ...overrides
  };
}

test("put and get round-trip all checkpoint fields including record_ids JSON payloads", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createCheckpointStore(db, {
      ttl_ms: 100,
      now: () => now
    });
    const record = createCheckpointRecord();

    store.put(record);

    assert.deepEqual(store.get(record.checkpoint_id), {
      ...record,
      created_at: 1_000,
      ttl_expires_at: 1_100
    });
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("get returns undefined for unknown checkpoint ids", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createCheckpointStore(db);

    assert.equal(store.get("missing-checkpoint"), undefined);
  } finally {
    db.close();
  }
});

test("get hides expired checkpoints once now passes ttl_expires_at", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createCheckpointStore(db, {
      ttl_ms: 100,
      now: () => now
    });
    const record = createCheckpointRecord();

    store.put(record);
    now = 1_101;

    assert.equal(store.get(record.checkpoint_id), undefined);
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("evictExpired removes only expired checkpoints and reports the deleted count", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createCheckpointStore(db, {
      ttl_ms: 100,
      now: () => now
    });

    store.put(createCheckpointRecord({ checkpoint_id: "expired" }));
    now = 1_050;
    store.put(createCheckpointRecord({ checkpoint_id: "fresh" }));
    now = 1_101;

    assert.equal(store.evictExpired(), 1);
    assert.equal(store.get("expired"), undefined);
    assert.deepEqual(store.get("fresh")?.record_ids, ["wiki:wiki-1", "vega_memory:mem-1"]);
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("put upserts by checkpoint_id and overwrites the prior payload", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createCheckpointStore(db, {
      ttl_ms: 100,
      now: () => now
    });

    store.put(createCheckpointRecord());
    now = 1_010;
    store.put(
      createCheckpointRecord({
        checkpoint_id: "checkpoint-1",
        bundle_digest: "bundle-2",
        query_hash: "query-hash-2",
        record_ids: ["wiki:wiki-2"]
      })
    );

    assert.deepEqual(store.get("checkpoint-1"), {
      ...createCheckpointRecord({
        checkpoint_id: "checkpoint-1",
        bundle_digest: "bundle-2",
        query_hash: "query-hash-2",
        record_ids: ["wiki:wiki-2"]
      }),
      created_at: now,
      ttl_expires_at: now + 100
    });
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("applyCheckpointStoreMigration is idempotent", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    assert.doesNotThrow(() => applyCheckpointStoreMigration(db));
    assert.doesNotThrow(() => applyCheckpointStoreMigration(db));
  } finally {
    db.close();
  }
});

test("checkpoint lineage fields round-trip through the store", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createCheckpointStore(db, { now: () => 1_000 });
    store.put(
      createCheckpointRecord({
        checkpoint_id: "checkpoint-followup-1",
        intent: "followup",
        prev_checkpoint_id: "checkpoint-root",
        lineage_root_checkpoint_id: "checkpoint-root",
        followup_depth: 1
      })
    );

    assert.deepEqual(store.get("checkpoint-followup-1"), {
      ...createCheckpointRecord({
        checkpoint_id: "checkpoint-followup-1",
        intent: "followup",
        prev_checkpoint_id: "checkpoint-root",
        lineage_root_checkpoint_id: "checkpoint-root",
        followup_depth: 1
      }),
      created_at: 1_000,
      ttl_expires_at: 1_000 + 1_800_000
    });
  } finally {
    db.close();
  }
});

test("get returns undefined instead of throwing for corrupt checkpoint rows", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createCheckpointStore(db, { now: () => 1_000 });

    db.run(
      `INSERT INTO ${RESOLVED_CHECKPOINTS_TABLE} (
        checkpoint_id,
        bundle_digest,
        intent,
        surface,
        session_id,
        project,
        cwd,
        query_hash,
        mode,
        profile_used,
        ranker_version,
        record_ids,
        created_at,
        ttl_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "bad-json",
      "bundle-1",
      "lookup",
      "codex",
      "session-1",
      "vega-memory",
      "/Users/johnmacmini/workspace/vega-memory",
      "query-1",
      "L1",
      "lookup",
      "v1.0",
      "{not-json",
      1_000,
      2_000
    );
    db.run(
      `INSERT INTO ${RESOLVED_CHECKPOINTS_TABLE} (
        checkpoint_id,
        bundle_digest,
        intent,
        surface,
        session_id,
        project,
        cwd,
        query_hash,
        mode,
        profile_used,
        ranker_version,
        record_ids,
        created_at,
        ttl_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "bad-ttl",
      "bundle-2",
      "lookup",
      "codex",
      "session-1",
      "vega-memory",
      "/Users/johnmacmini/workspace/vega-memory",
      "query-2",
      "L1",
      "lookup",
      "v1.0",
      "[\"wiki:wiki-1\"]",
      1_000,
      "oops"
    );

    assert.doesNotThrow(() => store.get("bad-json"));
    assert.equal(store.get("bad-json"), undefined);
    assert.equal(store.get("bad-ttl"), undefined);
  } finally {
    db.close();
  }
});
