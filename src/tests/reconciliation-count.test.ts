import assert from "node:assert/strict";
import test from "node:test";

import type { Memory, MemorySourceContext } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { insertRawEvent, applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { runCountDimension } from "../reconciliation/count-dimension.js";

const WINDOW_START = Date.parse("2026-04-20T00:00:00.000Z");
const WINDOW_END = Date.parse("2026-04-21T00:00:00.000Z");

function createMemory(
  id: string,
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> {
  const createdAt = overrides.created_at ?? "2026-04-20T12:00:00.000Z";

  return {
    id,
    tenant_id: null,
    type: "decision",
    project: "vega-memory",
    title: `Memory ${id}`,
    content: `Content ${id}`,
    summary: null,
    embedding: null,
    importance: 0.5,
    source: "explicit",
    tags: ["reconciliation"],
    created_at: createdAt,
    updated_at: createdAt,
    accessed_at: createdAt,
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega-memory"],
    source_context: null,
    ...overrides
  };
}

function createCandidatePromotionContext(): MemorySourceContext {
  return {
    actor: "tester",
    channel: "vega_internal",
    device_id: "vega-memory",
    device_name: "Vega Memory",
    platform: "server",
    session_id: "session-1",
    integration: "candidate_promotion"
  };
}

function insertShadowEnvelope(
  repository: Repository,
  eventId: string,
  eventType: "decision" | "state_change",
  hostTimestamp = "2026-04-20T12:00:00.000Z"
): void {
  insertRawEvent(repository.db, {
    schema_version: "1.0",
    event_id: eventId,
    surface: "api",
    session_id: "session-1",
    thread_id: null,
    project: "vega-memory",
    cwd: null,
    host_timestamp: hostTimestamp,
    role: "system",
    event_type: eventType,
    payload: {
      memory_type: "decision",
      title: `Envelope ${eventId}`,
      content: `Envelope ${eventId}`,
      summary: null,
      tags: ["reconciliation"]
    },
    safety: {
      redacted: false,
      categories: []
    },
    artifacts: [],
    source_kind: "vega_memory"
  });
}

function getFinding(
  result: Awaited<ReturnType<typeof runCountDimension>>,
  direction: "forward" | "reverse",
  eventType: "decision" | "state_change"
) {
  const finding = result.findings.find(
    (entry) => entry.direction === direction && entry.event_type === eventType
  );

  assert.ok(finding, `missing ${direction}/${eventType} finding`);
  return finding;
}

test("runCountDimension detects a forward shadow-write miss", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(
      createMemory("11111111-1111-4111-8111-111111111111")
    );
    repository.createMemory(
      createMemory("22222222-2222-4222-8222-222222222222")
    );
    insertShadowEnvelope(repository, "11111111-1111-4111-8111-111111111111", "decision");

    const result = await runCountDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    const forwardDecision = getFinding(result, "forward", "decision");

    assert.equal(result.status, "fail");
    assert.equal(forwardDecision.expected, 2);
    assert.equal(forwardDecision.actual, 1);
    assert.equal(forwardDecision.mismatch_count, 1);
    assert.deepEqual(forwardDecision.sample_ids, ["22222222-2222-4222-8222-222222222222"]);
  } finally {
    repository.close();
  }
});

test("runCountDimension detects a reverse orphan envelope", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(
      createMemory("33333333-3333-4333-8333-333333333333")
    );
    insertShadowEnvelope(repository, "33333333-3333-4333-8333-333333333333", "decision");
    insertShadowEnvelope(repository, "44444444-4444-4444-8444-444444444444", "state_change");

    const result = await runCountDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    const reverseStateChange = getFinding(result, "reverse", "state_change");

    assert.equal(result.status, "fail");
    assert.equal(reverseStateChange.expected, 1);
    assert.equal(reverseStateChange.actual, 0);
    assert.equal(reverseStateChange.mismatch_count, 1);
    assert.deepEqual(reverseStateChange.sample_ids, ["44444444-4444-4444-8444-444444444444"]);
  } finally {
    repository.close();
  }
});

test("runCountDimension passes when both forward and reverse counts reconcile", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(
      createMemory("55555555-5555-4555-8555-555555555555")
    );
    repository.createMemory(
      createMemory("66666666-6666-4666-8666-666666666666", {
        source: "auto",
        source_context: createCandidatePromotionContext()
      })
    );
    insertShadowEnvelope(repository, "55555555-5555-4555-8555-555555555555", "decision");
    insertShadowEnvelope(repository, "66666666-6666-4666-8666-666666666666", "state_change");

    const result = await runCountDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    assert.equal(result.status, "pass");
    assert.equal(result.findings.length, 4);
    assert.deepEqual(
      result.findings.map((finding) => finding.mismatch_count),
      [0, 0, 0, 0]
    );
  } finally {
    repository.close();
  }
});

test("runCountDimension returns zero mismatches for an empty window", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);

    const result = await runCountDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    assert.equal(result.status, "pass");
    for (const finding of result.findings) {
      assert.equal(finding.expected, 0);
      assert.equal(finding.actual, 0);
      assert.equal(finding.mismatch_count, 0);
      assert.deepEqual(finding.sample_ids, []);
    }
  } finally {
    repository.close();
  }
});

test("runCountDimension caps mismatched sample IDs at ten", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);

    for (let index = 0; index < 12; index += 1) {
      repository.createMemory(
        createMemory(`77777777-7777-4777-8777-${String(index).padStart(12, "0")}`)
      );
    }

    const result = await runCountDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    const forwardDecision = getFinding(result, "forward", "decision");

    assert.equal(forwardDecision.mismatch_count, 12);
    assert.equal(forwardDecision.sample_ids?.length, 10);
  } finally {
    repository.close();
  }
});
