import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  applyCheckpointFailureStoreMigration,
  createCheckpointFailureStore
} from "../usage/index.js";

interface TableInfoRow {
  name: string;
}

const createFailure = (
  overrides: Partial<{
    checkpoint_id: string;
    reason: string;
    intent: "lookup" | "bootstrap" | "followup" | "evidence";
    surface: "codex" | "claude" | "cursor" | "api";
    session_id: string;
    project: string | null;
    cwd: string | null;
    query_hash: string;
    mode: "L0" | "L1" | "L2" | "L3";
    profile_used: string;
    ranker_version: string;
    payload: string;
  }> = {}
) => ({
  checkpoint_id: "checkpoint-1",
  reason: "resolve_failed",
  intent: "lookup" as const,
  surface: "codex" as const,
  session_id: "session-1",
  project: "vega-memory",
  cwd: "/Users/johnmacmini/workspace/vega-memory",
  query_hash: "query-hash-1",
  mode: "L1" as const,
  profile_used: "lookup",
  ranker_version: "v1.0",
  payload: JSON.stringify({ error: "boom" }),
  ...overrides
});

test("checkpoint failure store put generates id and occurred_at", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createCheckpointFailureStore(db, {
      idFactory: () => "failure-1",
      now: () => 1_234
    });

    const saved = store.put(createFailure());

    assert.equal(saved.id, "failure-1");
    assert.equal(saved.occurred_at, 1_234);
    assert.equal(store.size(), 1);
  } finally {
    db.close();
  }
});

test("checkpoint failure store listRecent returns newest first", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 100;
  let id = 0;

  try {
    const store = createCheckpointFailureStore(db, {
      idFactory: () => `failure-${++id}`,
      now: () => now
    });

    store.put(createFailure({ checkpoint_id: "checkpoint-1" }));
    now = 200;
    store.put(createFailure({ checkpoint_id: "checkpoint-2" }));

    assert.deepEqual(
      store.listRecent().map((record) => record.checkpoint_id),
      ["checkpoint-2", "checkpoint-1"]
    );
  } finally {
    db.close();
  }
});

test("checkpoint failure store migration is idempotent", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    assert.doesNotThrow(() => applyCheckpointFailureStoreMigration(db));
    assert.doesNotThrow(() => applyCheckpointFailureStoreMigration(db));

    const columns = db
      .prepare<[], TableInfoRow>("PRAGMA table_info(checkpoint_failures)")
      .all()
      .map((column) => column.name);

    assert.ok(columns.includes("session_id"));
  } finally {
    db.close();
  }
});

test("checkpoint failure store uses injected idFactory and now values", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 10;
  let id = 0;

  try {
    const store = createCheckpointFailureStore(db, {
      idFactory: () => `custom-${++id}`,
      now: () => now
    });

    const first = store.put(createFailure({ checkpoint_id: "checkpoint-1" }));
    now = 20;
    const second = store.put(createFailure({ checkpoint_id: "checkpoint-2" }));

    assert.equal(first.id, "custom-1");
    assert.equal(first.occurred_at, 10);
    assert.equal(second.id, "custom-2");
    assert.equal(second.occurred_at, 20);
  } finally {
    db.close();
  }
});
