import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  applyPromotionAuditMigration,
  createPromotionAuditStore
} from "../promotion/audit-store.js";

test("promotion audit migration is idempotent", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    assert.doesNotThrow(() => applyPromotionAuditMigration(db));
    assert.doesNotThrow(() => applyPromotionAuditMigration(db));
  } finally {
    db.close();
  }
});

test("promotion audit store writes entries and returns newest-first queries", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const store = createPromotionAuditStore(db, {
      now: () => now,
      idFactory: (() => {
        let index = 0;
        return () => `audit-${++index}`;
      })()
    });

    const first = store.put({
      memory_id: "memory-1",
      action: "hold",
      trigger: "policy",
      from_state: "pending",
      to_state: "held",
      policy_name: "default",
      policy_version: "v1",
      reason: "still collecting evidence",
      actor: null
    });
    now += 10;
    const second = store.put({
      memory_id: "memory-1",
      action: "promote",
      trigger: "manual",
      from_state: "ready",
      to_state: "promoted",
      policy_name: "default",
      policy_version: "v1",
      reason: "manual promotion",
      actor: "tester"
    });
    now += 10;
    const third = store.put({
      memory_id: "memory-2",
      action: "demote",
      trigger: "manual",
      from_state: "promoted",
      to_state: "held",
      policy_name: "default",
      policy_version: "v1",
      reason: "manual demotion",
      actor: "tester"
    });

    assert.equal(first.id, "audit-1");
    assert.equal(second.id, "audit-2");
    assert.equal(third.id, "audit-3");
    assert.equal(store.size(), 3);
    assert.deepEqual(
      store.listByMemory("memory-1").map((entry) => entry.id),
      ["audit-2", "audit-1"]
    );
    assert.deepEqual(
      store.listRecent(2).map((entry) => entry.id),
      ["audit-3", "audit-2"]
    );
  } finally {
    db.close();
  }
});
