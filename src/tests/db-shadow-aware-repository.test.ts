import assert from "node:assert/strict";
import test from "node:test";

import type { LogRecord } from "../core/logging/index.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { createShadowAwareRepository } from "../db/shadow-aware-repository.js";
import { queryRawInbox, applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { createShadowWriter, type ShadowWriteOutcome } from "../ingestion/shadow-writer.js";

const FEATURE_FLAG = "VEGA_SHADOW_DUAL_WRITE";
const NOW = "2026-04-17T00:00:00.000Z";

function createMemory(overrides: Partial<Omit<Memory, "access_count">> = {}): Omit<Memory, "access_count"> {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    tenant_id: null,
    type: "decision",
    project: "vega-memory",
    title: "Decision",
    content: "Content",
    summary: "Summary",
    embedding: null,
    importance: 0.7,
    source: "explicit",
    tags: ["phase-8"],
    created_at: NOW,
    updated_at: NOW,
    accessed_at: NOW,
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega-memory"],
    source_context: {
      actor: "tester",
      channel: "cli",
      device_id: "device-1",
      device_name: "Mac",
      platform: "darwin",
      session_id: "session-1"
    },
    ...overrides
  };
}

function withFeatureFlag<T>(value: string | undefined, run: () => T): T {
  const previous = process.env[FEATURE_FLAG];

  if (value === undefined) {
    delete process.env[FEATURE_FLAG];
  } else {
    process.env[FEATURE_FLAG] = value;
  }

  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[FEATURE_FLAG];
    } else {
      process.env[FEATURE_FLAG] = previous;
    }
  }
}

function captureStructuredLogs<T>(run: () => T): { result: T; logs: LogRecord[] } {
  const originalConsoleLog = console.log;
  const logs: LogRecord[] = [];

  console.log = ((...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      try {
        logs.push(JSON.parse(args[0]) as LogRecord);
      } catch {
        return;
      }
    }
  }) as typeof console.log;

  try {
    return {
      result: run(),
      logs
    };
  } finally {
    console.log = originalConsoleLog;
  }
}

test("flag off keeps createMemory behavior unchanged and does not add raw_inbox rows", () => {
  withFeatureFlag(undefined, () => {
    const repository = new Repository(":memory:");

    try {
      applyRawInboxMigration(repository.db);
      const wrapped = createShadowAwareRepository(
        repository,
        createShadowWriter({ db: repository.db })
      );
      const memory = createMemory();

      wrapped.createMemory(memory);

      assert.deepEqual(wrapped.getMemory(memory.id), { ...memory, access_count: 0 });
      assert.equal(queryRawInbox(repository.db).length, 0);
    } finally {
      repository.close();
    }
  });
});

test("flag on writes a shadow envelope into raw_inbox after createMemory succeeds", () => {
  withFeatureFlag("true", () => {
    const repository = new Repository(":memory:");

    try {
      applyRawInboxMigration(repository.db);
      const wrapped = createShadowAwareRepository(
        repository,
        createShadowWriter({ db: repository.db })
      );
      const memory = createMemory();

      wrapped.createMemory(memory);

      const rows = queryRawInbox(repository.db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_id, memory.id);
      assert.equal(rows[0]?.surface, "api");
    } finally {
      repository.close();
    }
  });
});

test("repeated createMemory calls can dedupe the shadow write without throwing", () => {
  withFeatureFlag("true", () => {
    const repository = new Repository(":memory:");

    try {
      applyRawInboxMigration(repository.db);
      const calls: string[] = [];
      const inner = {
        db: repository.db,
        createMemory(memory: Omit<Memory, "access_count">) {
          calls.push(memory.id);
        }
      } as unknown as Repository;
      const wrapped = createShadowAwareRepository(inner, createShadowWriter({ db: repository.db }));
      const memory = createMemory();

      assert.doesNotThrow(() => {
        wrapped.createMemory(memory);
        wrapped.createMemory(memory);
      });
      assert.deepEqual(calls, [memory.id, memory.id]);
      assert.equal(queryRawInbox(repository.db).length, 1);
    } finally {
      repository.close();
    }
  });
});

test("flag on keeps updateMemory transparent and does not shadow maintenance updates", () => {
  withFeatureFlag("true", () => {
    const repository = new Repository(":memory:");

    try {
      applyRawInboxMigration(repository.db);
      const shadowWriter = createShadowWriter({ db: repository.db });
      const shadowCalls: ShadowWriteOutcome[] = [];
      const wrapped = createShadowAwareRepository(
        repository,
        (envelope) => {
          const outcome = shadowWriter(envelope);
          shadowCalls.push(outcome);
          return outcome;
        }
      );
      const memory = createMemory();

      wrapped.createMemory(memory);
      assert.equal(queryRawInbox(repository.db).length, 1);

      wrapped.updateMemory(memory.id, {
        content: "Updated content",
        updated_at: "2026-04-17T00:05:00.000Z"
      });

      const stored = wrapped.getMemory(memory.id);

      assert.equal(stored?.content, "Updated content");
      assert.equal(shadowCalls.length, 1);
      assert.equal(shadowCalls[0]?.accepted, true);
      assert.equal(queryRawInbox(repository.db).length, 1);
    } finally {
      repository.close();
    }
  });
});

test("shadow writer error outcomes are logged without breaking createMemory", () => {
  const repository = new Repository(":memory:");

  try {
    const wrapped = createShadowAwareRepository(repository, () => ({
      executed: true,
      accepted: false,
      reason: "error",
      error: "raw inbox unavailable"
    }));
    const memory = createMemory();

    const { result, logs } = captureStructuredLogs(() => wrapped.createMemory(memory));

    assert.equal(result, undefined);
    assert.deepEqual(wrapped.getMemory(memory.id), { ...memory, access_count: 0 });
    assert.ok(logs.some((record) => record.level === "warn" && record.message === "Shadow write failed"));
  } finally {
    repository.close();
  }
});

test("shadow writer throws are caught and logged without breaking createMemory", () => {
  const repository = new Repository(":memory:");

  try {
    const wrapped = createShadowAwareRepository(repository, () => {
      throw new Error("boom");
    });
    const memory = createMemory({ id: "55555555-5555-4555-8555-555555555555" });

    const { result, logs } = captureStructuredLogs(() => wrapped.createMemory(memory));

    assert.equal(result, undefined);
    assert.deepEqual(wrapped.getMemory(memory.id), { ...memory, access_count: 0 });
    assert.ok(
      logs.some((record) => record.level === "warn" && record.message === "Shadow write throw caught")
    );
  } finally {
    repository.close();
  }
});

test("non-createMemory methods are transparently bound back to the inner repository", () => {
  const repository = new Repository(":memory:");

  try {
    const expected = createMemory();
    repository.createMemory(expected);
    const wrapped = createShadowAwareRepository(repository, () => ({
      executed: false,
      reason: "disabled"
    }));

    assert.deepEqual(wrapped.getMemory(expected.id), { ...expected, access_count: 0 });
    assert.deepEqual(wrapped.listMemories({ limit: 10 }), repository.listMemories({ limit: 10 }));
  } finally {
    repository.close();
  }
});
