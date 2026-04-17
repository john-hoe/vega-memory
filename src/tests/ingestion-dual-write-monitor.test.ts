import assert from "node:assert/strict";
import test from "node:test";

import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { compareSingleWrite, DualWriteMonitor } from "../ingestion/dual-write-monitor.js";
import { applyRawInboxMigration, insertRawEvent } from "../ingestion/raw-inbox.js";

const createEnvelope = (overrides: Partial<HostEventEnvelopeV1> = {}): HostEventEnvelopeV1 => ({
  schema_version: "1.0",
  event_id: "33333333-3333-4333-8333-333333333333",
  surface: "codex",
  session_id: "session-3",
  thread_id: "thread-3",
  project: "vega-memory",
  cwd: "/workspace/vega-memory",
  host_timestamp: "2026-04-17T00:00:00.000Z",
  role: "assistant",
  event_type: "message",
  payload: { text: "hello" },
  safety: { redacted: false, categories: [] },
  artifacts: [],
  source_kind: "vega_memory",
  ...overrides
});

test("DualWriteMonitor increments counters for each outcome type", () => {
  const monitor = new DualWriteMonitor();

  monitor.recordOutcome({ executed: false, reason: "disabled" });
  monitor.recordOutcome({ executed: true, accepted: true, event_id: "event-1" });
  monitor.recordOutcome({
    executed: true,
    accepted: false,
    event_id: "event-2",
    reason: "deduped"
  });
  monitor.recordOutcome({
    executed: true,
    accepted: false,
    reason: "error",
    error: "boom"
  });

  assert.deepEqual(monitor.snapshot(), {
    shadow_attempts: 3,
    shadow_success: 1,
    shadow_deduped: 1,
    shadow_disabled: 1,
    shadow_errors: 1
  });
});

test("snapshot returns a copy that cannot mutate internal counters", () => {
  const monitor = new DualWriteMonitor();

  monitor.recordOutcome({ executed: true, accepted: true, event_id: "event-1" });

  const snapshot = monitor.snapshot();
  snapshot.shadow_success = 99;

  assert.equal(monitor.snapshot().shadow_success, 1);
});

test("compareSingleWrite reports raw_inbox presence by event_id", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);
    insertRawEvent(db, createEnvelope());

    assert.deepEqual(compareSingleWrite(db, "33333333-3333-4333-8333-333333333333"), {
      raw_inbox_present: true
    });
    assert.deepEqual(compareSingleWrite(db, "44444444-4444-4444-8444-444444444444"), {
      raw_inbox_present: false
    });
  } finally {
    db.close();
  }
});
