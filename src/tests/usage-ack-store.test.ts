import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  applyAckStoreMigration,
  createAckStore
} from "../usage/index.js";

const createAck = (
  overrides: Partial<{
    checkpoint_id: string;
    bundle_digest: string;
    sufficiency: "sufficient" | "needs_followup" | "needs_external";
    host_tier: "T1" | "T2" | "T3";
    evidence?: string;
    turn_elapsed_ms?: number;
  }> = {}
) => ({
  checkpoint_id: "checkpoint-1",
  bundle_digest: "bundle-1",
  sufficiency: "sufficient" as const,
  host_tier: "T2" as const,
  evidence: "enough evidence",
  turn_elapsed_ms: 125,
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
