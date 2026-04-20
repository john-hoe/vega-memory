import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseAdapter } from "../db/adapter.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  RESTORE_AUDIT_TABLE,
  applyRestoreAuditMigration,
  listRestoreAudit,
  recordRestoreAudit
} from "../backup/audit.js";

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

test("applyRestoreAuditMigration is idempotent on SQLite", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    assert.doesNotThrow(() => applyRestoreAuditMigration(db));
    assert.doesNotThrow(() => applyRestoreAuditMigration(db));
  } finally {
    db.close();
  }
});

test("recordRestoreAudit inserts restore audit rows", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRestoreAuditMigration(db);
    recordRestoreAudit(db, {
      backup_id: "2026-04-20T12-34-56Z",
      mode: "full",
      operator: "tester",
      before_state_sha256: "before-hash",
      after_state_sha256: "after-hash",
      restored_at: 1_000,
      verified: true,
      mismatches: []
    });

    const row = db.get<{
      backup_id: string;
      mode: string;
      operator: string;
      verified: number;
    }>(`SELECT backup_id, mode, operator, verified FROM ${RESTORE_AUDIT_TABLE} LIMIT 1`);

    assert.deepEqual(row, {
      backup_id: "2026-04-20T12-34-56Z",
      mode: "full",
      operator: "tester",
      verified: 1
    });
  } finally {
    db.close();
  }
});

test("listRestoreAudit returns newest-first rows and honors the limit", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRestoreAuditMigration(db);
    recordRestoreAudit(db, {
      backup_id: "backup-1",
      mode: "full",
      operator: "tester",
      before_state_sha256: "before-1",
      after_state_sha256: "after-1",
      restored_at: 1_000,
      verified: true,
      mismatches: []
    });
    recordRestoreAudit(db, {
      backup_id: "backup-2",
      mode: "drill",
      operator: "tester",
      before_state_sha256: null,
      after_state_sha256: null,
      restored_at: 2_000,
      verified: false,
      mismatches: ["vega.db"]
    });

    const rows = listRestoreAudit(db, { limit: 1 });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.backup_id, "backup-2");
    assert.deepEqual(rows[0]?.mismatches, ["vega.db"]);
  } finally {
    db.close();
  }
});

test("restore audit helpers no-op safely for Postgres adapters", () => {
  const db = createPostgresStub();

  applyRestoreAuditMigration(db);
  recordRestoreAudit(db, {
    backup_id: "backup-1",
    mode: "drill",
    operator: "tester",
    before_state_sha256: null,
    after_state_sha256: null,
    restored_at: 1_000,
    verified: true,
    mismatches: []
  });

  assert.deepEqual(listRestoreAudit(db, { limit: 10 }), []);
});
