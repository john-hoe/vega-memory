import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  applyUsageConsumptionCheckpointStoreMigration,
  createUsageConsumptionCheckpointStore,
  USAGE_CONSUMPTION_CHECKPOINTS_TABLE
} from "../usage/index.js";

test("put and get round-trip all checkpoint fields", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createUsageConsumptionCheckpointStore(db, {
      ttl_ms: 100,
      now: () => now
    });

    store.put({
      bundle_id: "bundle-1",
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      used_items: ["wiki:wiki-1", "vega_memory:mem-1"],
      working_summary: "Host consumed bundle and identified next steps."
    });

    const record = store.get("checkpoint-1");

    assert.equal(record?.bundle_id, "bundle-1");
    assert.equal(record?.checkpoint_id, "checkpoint-1");
    assert.equal(record?.decision_state, "sufficient");
    assert.deepEqual(record?.used_items, ["wiki:wiki-1", "vega_memory:mem-1"]);
    assert.equal(record?.working_summary, "Host consumed bundle and identified next steps.");
    assert.equal(record?.submitted_at, 1_000);
    assert.equal(record?.ttl_expires_at, 1_100);
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("get returns undefined for unknown checkpoint ids", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createUsageConsumptionCheckpointStore(db);

    assert.equal(store.get("missing-checkpoint"), undefined);
  } finally {
    db.close();
  }
});

test("get hides expired checkpoints once now passes ttl_expires_at", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createUsageConsumptionCheckpointStore(db, {
      ttl_ms: 100,
      now: () => now
    });

    store.put({
      bundle_id: "bundle-1",
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      used_items: ["wiki:wiki-1"],
      working_summary: "Summary."
    });

    now = 1_101;

    assert.equal(store.get("checkpoint-1"), undefined);
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("evictExpired removes only expired checkpoints and reports the deleted count", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createUsageConsumptionCheckpointStore(db, {
      ttl_ms: 100,
      now: () => now
    });

    store.put({
      bundle_id: "bundle-1",
      checkpoint_id: "expired",
      decision_state: "sufficient",
      used_items: ["wiki:wiki-1"],
      working_summary: "Summary."
    });

    now = 1_050;

    store.put({
      bundle_id: "bundle-2",
      checkpoint_id: "fresh",
      decision_state: "needs_followup",
      used_items: ["wiki:wiki-2"],
      working_summary: "Another summary."
    });

    now = 1_101;

    assert.equal(store.evictExpired(), 1);
    assert.equal(store.get("expired"), undefined);
    assert.equal(store.get("fresh")?.bundle_id, "bundle-2");
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("put upserts by checkpoint_id and overwrites the prior payload", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createUsageConsumptionCheckpointStore(db, {
      ttl_ms: 100,
      now: () => now
    });

    store.put({
      bundle_id: "bundle-1",
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      used_items: ["wiki:wiki-1"],
      working_summary: "First summary."
    });

    now = 1_010;

    store.put({
      bundle_id: "bundle-2",
      checkpoint_id: "checkpoint-1",
      decision_state: "needs_external",
      used_items: ["wiki:wiki-2", "vega_memory:mem-2"],
      working_summary: "Second summary."
    });

    const record = store.get("checkpoint-1");

    assert.equal(record?.bundle_id, "bundle-2");
    assert.equal(record?.decision_state, "needs_external");
    assert.deepEqual(record?.used_items, ["wiki:wiki-2", "vega_memory:mem-2"]);
    assert.equal(record?.working_summary, "Second summary.");
    assert.equal(record?.submitted_at, 1_010);
    assert.equal(record?.ttl_expires_at, 1_110);
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("applyUsageConsumptionCheckpointStoreMigration is idempotent", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    assert.doesNotThrow(() => applyUsageConsumptionCheckpointStoreMigration(db));
    assert.doesNotThrow(() => applyUsageConsumptionCheckpointStoreMigration(db));
  } finally {
    db.close();
  }
});

test("get returns undefined instead of throwing for corrupt checkpoint rows", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createUsageConsumptionCheckpointStore(db, { now: () => 1_000 });

    db.run(
      `INSERT INTO ${USAGE_CONSUMPTION_CHECKPOINTS_TABLE} (
        checkpoint_id,
        bundle_id,
        decision_state,
        used_items,
        working_summary,
        submitted_at,
        ttl_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "bad-json",
      "bundle-1",
      "sufficient",
      "{not-json",
      "Summary.",
      1_000,
      2_000
    );

    db.run(
      `INSERT INTO ${USAGE_CONSUMPTION_CHECKPOINTS_TABLE} (
        checkpoint_id,
        bundle_id,
        decision_state,
        used_items,
        working_summary,
        submitted_at,
        ttl_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "bad-ttl",
      "bundle-2",
      "needs_followup",
      "[\"wiki:wiki-1\"]",
      "Summary.",
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

test("store handles all three decision_state values", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createUsageConsumptionCheckpointStore(db, { now: () => 1_000 });

    for (const decision_state of ["sufficient", "needs_followup", "needs_external"] as const) {
      store.put({
        bundle_id: `bundle-${decision_state}`,
        checkpoint_id: `checkpoint-${decision_state}`,
        decision_state,
        used_items: ["wiki:wiki-1"],
        working_summary: `Summary for ${decision_state}.`
      });

      const record = store.get(`checkpoint-${decision_state}`);
      assert.equal(record?.decision_state, decision_state);
    }

    assert.equal(store.size(), 3);
  } finally {
    db.close();
  }
});

test("store rejects invalid decision_state at schema level", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createUsageConsumptionCheckpointStore(db);

    assert.throws(() => {
      store.put({
        bundle_id: "bundle-1",
        checkpoint_id: "checkpoint-1",
        decision_state: "invalid_state" as never,
        used_items: ["wiki:wiki-1"],
        working_summary: "Summary."
      });
    });
  } finally {
    db.close();
  }
});

test("store size returns 0 for empty store", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createUsageConsumptionCheckpointStore(db);

    assert.equal(store.size(), 0);
  } finally {
    db.close();
  }
});

test("store get with explicit now parameter respects TTL", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createUsageConsumptionCheckpointStore(db, {
      ttl_ms: 100,
      now: () => 1_000
    });

    store.put({
      bundle_id: "bundle-1",
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      used_items: ["wiki:wiki-1"],
      working_summary: "Summary."
    });

    assert.equal(store.get("checkpoint-1", 1_050)?.checkpoint_id, "checkpoint-1");
    assert.equal(store.get("checkpoint-1", 1_101), undefined);
  } finally {
    db.close();
  }
});

test("store evictExpired with explicit now parameter removes only expired records", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createUsageConsumptionCheckpointStore(db, {
      ttl_ms: 100,
      now: () => 1_000
    });

    store.put({
      bundle_id: "bundle-1",
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      used_items: ["wiki:wiki-1"],
      working_summary: "Summary."
    });

    assert.equal(store.evictExpired(1_050), 0);
    assert.equal(store.size(), 1);
    assert.equal(store.evictExpired(1_101), 1);
    assert.equal(store.size(), 0);
  } finally {
    db.close();
  }
});
