import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseAdapter } from "../db/adapter.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  ALERT_HISTORY_TABLE,
  applyAlertHistoryMigration,
  isInCooldown,
  markAlertResolved,
  recordAlertFired
} from "../alert/index.js";

const createPostgresStub = (): DatabaseAdapter => ({
  isPostgres: true,
  run() {},
  get() {
    return undefined;
  },
  all() {
    return [];
  },
  exec() {},
  prepare() {
    return {
      run() {},
      get() {
        return undefined;
      },
      all() {
        return [];
      }
    };
  },
  transaction<T>(fn: () => T): T {
    return fn();
  },
  close() {}
});

test("recordAlertFired inserts alert history rows", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyAlertHistoryMigration(db);
    recordAlertFired(db, {
      rule_id: "raw_inbox_backlog_high",
      severity: "warn",
      value: 123,
      fired_at: 1000,
      channels: ["default_webhook"],
      dispatch_status: {
        default_webhook: "ok"
      }
    });

    const row = db.get<{
      rule_id: string;
      severity: string;
      value: number;
      resolved_at: number | null;
    }>(`SELECT rule_id, severity, value, resolved_at FROM ${ALERT_HISTORY_TABLE} LIMIT 1`);

    assert.deepEqual(row, {
      rule_id: "raw_inbox_backlog_high",
      severity: "warn",
      value: 123,
      resolved_at: null
    });
  } finally {
    db.close();
  }
});

test("isInCooldown returns true for the latest unresolved row inside the cooldown window", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyAlertHistoryMigration(db);
    recordAlertFired(db, {
      rule_id: "raw_inbox_backlog_high",
      severity: "warn",
      value: 123,
      fired_at: 5_000,
      channels: ["default_webhook"],
      dispatch_status: {
        default_webhook: "ok"
      }
    });

    assert.equal(isInCooldown(db, "raw_inbox_backlog_high", 10_000, 10_000), true);
  } finally {
    db.close();
  }
});

test("isInCooldown returns false after the cooldown has expired", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyAlertHistoryMigration(db);
    recordAlertFired(db, {
      rule_id: "raw_inbox_backlog_high",
      severity: "warn",
      value: 123,
      fired_at: 5_000,
      channels: ["default_webhook"],
      dispatch_status: {
        default_webhook: "ok"
      }
    });

    assert.equal(isInCooldown(db, "raw_inbox_backlog_high", 20_001, 10_000), false);
  } finally {
    db.close();
  }
});

test("markAlertResolved updates the latest unresolved row for a rule", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyAlertHistoryMigration(db);
    recordAlertFired(db, {
      rule_id: "raw_inbox_backlog_high",
      severity: "warn",
      value: 123,
      fired_at: 5_000,
      channels: ["default_webhook"],
      dispatch_status: {
        default_webhook: "ok"
      }
    });

    markAlertResolved(db, "raw_inbox_backlog_high", 9_000);

    const row = db.get<{ resolved_at: number | null }>(
      `SELECT resolved_at FROM ${ALERT_HISTORY_TABLE} WHERE rule_id = ?`,
      "raw_inbox_backlog_high"
    );
    assert.equal(row?.resolved_at, 9_000);
  } finally {
    db.close();
  }
});

test("alert history helpers no-op safely for Postgres adapters", () => {
  const db = createPostgresStub();

  applyAlertHistoryMigration(db);
  recordAlertFired(db, {
    rule_id: "raw_inbox_backlog_high",
    severity: "warn",
    value: 123,
    fired_at: 5_000,
    channels: ["default_webhook"],
    dispatch_status: {
      default_webhook: "ok"
    }
  });
  markAlertResolved(db, "raw_inbox_backlog_high", 9_000);

  assert.equal(isInCooldown(db, "raw_inbox_backlog_high", 10_000, 10_000), false);
});
