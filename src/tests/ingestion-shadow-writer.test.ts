import assert from "node:assert/strict";
import test from "node:test";

import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { queryRawInbox, applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { createShadowWriter } from "../ingestion/shadow-writer.js";

const FEATURE_FLAG = "VEGA_SHADOW_DUAL_WRITE";

const createEnvelope = (overrides: Partial<HostEventEnvelopeV1> = {}): HostEventEnvelopeV1 => ({
  schema_version: "1.0",
  event_id: "22222222-2222-4222-8222-222222222222",
  surface: "codex",
  session_id: "session-2",
  thread_id: "thread-2",
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

test("shadow writer returns disabled and does not write when the flag is off", () => {
  const db = new SQLiteAdapter(":memory:");
  const previous = process.env[FEATURE_FLAG];

  try {
    delete process.env[FEATURE_FLAG];
    applyRawInboxMigration(db);

    const shadowWrite = createShadowWriter({ db });
    const outcome = shadowWrite(createEnvelope());

    assert.deepEqual(outcome, {
      executed: false,
      reason: "disabled"
    });
    assert.equal(queryRawInbox(db).length, 0);
  } finally {
    if (previous === undefined) {
      delete process.env[FEATURE_FLAG];
    } else {
      process.env[FEATURE_FLAG] = previous;
    }
    db.close();
  }
});

test("shadow writer writes to raw_inbox when the flag is on", () => {
  const db = new SQLiteAdapter(":memory:");
  const previous = process.env[FEATURE_FLAG];

  try {
    process.env[FEATURE_FLAG] = "on";
    applyRawInboxMigration(db);

    const shadowWrite = createShadowWriter({ db });
    const outcome = shadowWrite(createEnvelope());

    assert.equal(outcome.executed, true);
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.event_id, "22222222-2222-4222-8222-222222222222");
    assert.equal(outcome.reason, undefined);
    assert.equal(queryRawInbox(db).length, 1);
  } finally {
    if (previous === undefined) {
      delete process.env[FEATURE_FLAG];
    } else {
      process.env[FEATURE_FLAG] = previous;
    }
    db.close();
  }
});

test("shadow writer reports deduped on a repeated event_id", () => {
  const db = new SQLiteAdapter(":memory:");
  const previous = process.env[FEATURE_FLAG];

  try {
    process.env[FEATURE_FLAG] = "true";
    applyRawInboxMigration(db);

    const shadowWrite = createShadowWriter({ db });
    const envelope = createEnvelope();

    const first = shadowWrite(envelope);
    const second = shadowWrite(envelope);

    assert.equal(first.accepted, true);
    assert.deepEqual(second, {
      executed: true,
      accepted: false,
      event_id: "22222222-2222-4222-8222-222222222222",
      reason: "deduped"
    });
  } finally {
    if (previous === undefined) {
      delete process.env[FEATURE_FLAG];
    } else {
      process.env[FEATURE_FLAG] = previous;
    }
    db.close();
  }
});

test("shadow writer returns an error outcome instead of throwing", () => {
  const db = new SQLiteAdapter(":memory:");
  const previous = process.env[FEATURE_FLAG];

  try {
    process.env[FEATURE_FLAG] = "1";

    const shadowWrite = createShadowWriter({ db });
    const outcome = shadowWrite({
      ...createEnvelope(),
      surface: "claude-code"
    } as unknown as HostEventEnvelopeV1);

    assert.equal(outcome.executed, true);
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.reason, "error");
    assert.match(outcome.error ?? "", /raw_inbox|no such table/i);
  } finally {
    if (previous === undefined) {
      delete process.env[FEATURE_FLAG];
    } else {
      process.env[FEATURE_FLAG] = previous;
    }
    db.close();
  }
});
