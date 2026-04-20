import assert from "node:assert/strict";
import test from "node:test";

import type { Logger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import type { TimeoutPolicyDecision } from "../timeout/policy.js";
import {
  recordTimeoutFailure
} from "../timeout/recorder.js";

const createLoggerStub = (): {
  logger: Logger;
  warns: Array<{ message: string; context?: Record<string, unknown> }>;
  debugs: Array<{ message: string; context?: Record<string, unknown> }>;
} => {
  const warns: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const debugs: Array<{ message: string; context?: Record<string, unknown> }> = [];

  const logger: Logger = {
    debug(message, context) {
      debugs.push({ message, context });
    },
    info() {},
    warn(message, context) {
      warns.push({ message, context });
    },
    error() {},
    withTraceId() {
      return logger;
    }
  };

  return { logger, warns, debugs };
};

const createDetectedAt = (): number => 1_700_000_000_000;

const createHardFailureDecision = (): TimeoutPolicyDecision => ({
  decision: "hard_failure",
  reason: "l1_ttl_expired_tier_t3"
});

test("recordTimeoutFailure inserts checkpoint_failures rows for hard_failure decisions", () => {
  const db = new SQLiteAdapter(":memory:");

  db.exec(`
    CREATE TABLE checkpoint_failures (
      id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  try {
    const result = recordTimeoutFailure(db, {
      checkpoint_id: "checkpoint-1",
      decision: createHardFailureDecision().decision,
      reason: createHardFailureDecision().reason,
      detected_at: createDetectedAt()
    });

    assert.deepEqual(result, {
      written: true,
      reason: "inserted"
    });
    assert.deepEqual(
      db.get<{
        checkpoint_id: string;
        reason: string;
        category: string;
        created_at: number;
      }>(
        "SELECT checkpoint_id, reason, category, created_at FROM checkpoint_failures WHERE checkpoint_id = ?",
        "checkpoint-1"
      ),
      {
        checkpoint_id: "checkpoint-1",
        reason: "l1_ttl_expired_tier_t3",
        category: "l1_ttl_expired",
        created_at: createDetectedAt()
      }
    );
  } finally {
    db.close();
  }
});

test("recordTimeoutFailure falls back to the minimal insert when category is unavailable", () => {
  const db = new SQLiteAdapter(":memory:");

  db.exec(`
    CREATE TABLE checkpoint_failures (
      id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  try {
    const result = recordTimeoutFailure(db, {
      checkpoint_id: "checkpoint-2",
      decision: "hard_failure",
      reason: "l1_ttl_expired_tier_unknown",
      detected_at: createDetectedAt()
    });

    assert.deepEqual(result, {
      written: true,
      reason: "inserted"
    });
    assert.deepEqual(
      db.get<{
        checkpoint_id: string;
        reason: string;
        created_at: number;
      }>(
        "SELECT checkpoint_id, reason, created_at FROM checkpoint_failures WHERE checkpoint_id = ?",
        "checkpoint-2"
      ),
      {
        checkpoint_id: "checkpoint-2",
        reason: "l1_ttl_expired_tier_unknown",
        created_at: createDetectedAt()
      }
    );
  } finally {
    db.close();
  }
});

test("recordTimeoutFailure updates checkpoint status for presumed_sufficient decisions", () => {
  const db = new SQLiteAdapter(":memory:");

  db.exec(`
    CREATE TABLE checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      status TEXT
    )
  `);
  db.exec(`
    CREATE TABLE checkpoint_failures (
      id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run("INSERT INTO checkpoints (checkpoint_id, status) VALUES (?, ?)", "checkpoint-3", "open");

  try {
    const result = recordTimeoutFailure(db, {
      checkpoint_id: "checkpoint-3",
      decision: "presumed_sufficient",
      reason: "l1_ttl_expired_tier_t1",
      detected_at: createDetectedAt()
    });

    assert.deepEqual(result, {
      written: false,
      reason: "presumed_sufficient"
    });
    assert.equal(
      db.get<{ status: string }>(
        "SELECT status FROM checkpoints WHERE checkpoint_id = ?",
        "checkpoint-3"
      )?.status,
      "expired_degraded"
    );
    assert.equal(
      db.get<{ count: number }>("SELECT COUNT(*) AS count FROM checkpoint_failures")?.count,
      0
    );
  } finally {
    db.close();
  }
});

test("recordTimeoutFailure is a safe no-op for Postgres adapters", () => {
  const db: DatabaseAdapter = {
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
      throw new Error("prepare should not be called");
    },
    transaction(fn) {
      return fn();
    },
    close() {}
  };

  assert.deepEqual(
    recordTimeoutFailure(db, {
      checkpoint_id: "checkpoint-4",
      decision: "hard_failure",
      reason: "l1_ttl_expired_tier_t3",
      detected_at: createDetectedAt()
    }),
    {
      written: false,
      reason: "sqlite_only"
    }
  );
});

test("recordTimeoutFailure logs and returns written false when inserts fail", () => {
  const db = new SQLiteAdapter(":memory:");
  const { logger, warns } = createLoggerStub();

  db.exec(`
    CREATE TABLE checkpoint_failures (
      id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TRIGGER fail_timeout_insert
    BEFORE INSERT ON checkpoint_failures
    BEGIN
      SELECT RAISE(FAIL, 'boom');
    END
  `);

  try {
    const result = recordTimeoutFailure(db, {
      checkpoint_id: "checkpoint-5",
      decision: "hard_failure",
      reason: "l1_ttl_expired_tier_t3",
      detected_at: createDetectedAt(),
      logger
    });

    assert.deepEqual(result, {
      written: false,
      reason: "boom"
    });
    assert.equal(warns.length, 1);
    assert.match(warns[0]?.message ?? "", /timeout/i);
  } finally {
    db.close();
  }
});
