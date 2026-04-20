import assert from "node:assert/strict";
import test from "node:test";

import { Repository } from "../db/repository.js";
import { applyRawInboxMigration, insertRawEvent } from "../ingestion/raw-inbox.js";
import { runOrderingDimension } from "../reconciliation/ordering-dimension.js";

const WINDOW_START = Date.parse("2026-04-20T00:00:00.000Z");
const WINDOW_END = Date.parse("2026-04-21T00:00:00.000Z");
const BASE_TIME = "2026-04-20T12:00:00.000Z";

function createMemory(id: string, createdAt = BASE_TIME) {
  return {
    id,
    tenant_id: null,
    type: "decision" as const,
    project: "vega-memory",
    title: `Memory ${id}`,
    content: `Content ${id}`,
    summary: null,
    embedding: null,
    importance: 0.5,
    source: "explicit" as const,
    tags: ["reconciliation"],
    created_at: createdAt,
    updated_at: createdAt,
    accessed_at: createdAt,
    status: "active" as const,
    verified: "unverified" as const,
    scope: "project" as const,
    accessed_projects: ["vega-memory"],
    source_context: null
  };
}

function insertDecisionEnvelope(repository: Repository, eventId: string): void {
  insertRawEvent(repository.db, {
    schema_version: "1.0",
    event_id: eventId,
    surface: "api",
    session_id: "session-1",
    thread_id: null,
    project: "vega-memory",
    cwd: null,
    host_timestamp: BASE_TIME,
    role: "system",
    event_type: "decision",
    payload: {
      memory_type: "decision",
      title: `Envelope ${eventId}`,
      content: `Content ${eventId}`,
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

function setReceivedAt(repository: Repository, eventId: string, receivedAt: string): void {
  repository.db.run(
    "UPDATE raw_inbox SET received_at = ? WHERE event_id = ?",
    receivedAt,
    eventId
  );
}

function withEnv(name: string, value: string | undefined, fn: () => Promise<void> | void) {
  const previous = process.env[name];

  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function getDriftFinding(result: Awaited<ReturnType<typeof runOrderingDimension>>) {
  const finding = result.findings.find((entry) => entry.status === "fail");
  assert.ok(finding, "expected a fail finding");
  return finding;
}

async function runOrderingDimensionFor1200MsDrift(args?: { tolerance_ms?: number }) {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("77777777-7777-4777-8777-777777777777"));
    insertDecisionEnvelope(repository, "77777777-7777-4777-8777-777777777777");
    setReceivedAt(repository, "77777777-7777-4777-8777-777777777777", "2026-04-20T12:00:01.200Z");

    return await runOrderingDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      ...args
    });
  } finally {
    repository.close();
  }
}

test("runOrderingDimension passes when drift stays within tolerance", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("11111111-1111-4111-8111-111111111111"));
    insertDecisionEnvelope(repository, "11111111-1111-4111-8111-111111111111");
    setReceivedAt(repository, "11111111-1111-4111-8111-111111111111", "2026-04-20T12:00:03.000Z");

    const result = await runOrderingDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    assert.equal(result.status, "pass");
    assert.equal(result.findings.every((finding) => finding.status === "pass"), true);
  } finally {
    repository.close();
  }
});

test("runOrderingDimension reports timestamp drift above tolerance with delta_ms", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("22222222-2222-4222-8222-222222222222"));
    insertDecisionEnvelope(repository, "22222222-2222-4222-8222-222222222222");
    setReceivedAt(repository, "22222222-2222-4222-8222-222222222222", "2026-04-20T12:00:07.500Z");

    const result = await runOrderingDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    const finding = getDriftFinding(result);

    assert.equal(result.status, "fail");
    assert.equal(finding.mismatch_count, 1);
    assert.deepEqual(finding.sample_ids, ["22222222-2222-4222-8222-222222222222"]);
    assert.deepEqual(finding.payload, {
      mismatch_type: "timestamp_drift",
      sample_ids: ["22222222-2222-4222-8222-222222222222"],
      delta_ms: 7500
    });
  } finally {
    repository.close();
  }
});

test("runOrderingDimension respects VEGA_RECONCILIATION_ORDERING_TOLERANCE_MS", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("33333333-3333-4333-8333-333333333333"));
    insertDecisionEnvelope(repository, "33333333-3333-4333-8333-333333333333");
    setReceivedAt(repository, "33333333-3333-4333-8333-333333333333", "2026-04-20T12:00:01.200Z");

    await withEnv("VEGA_RECONCILIATION_ORDERING_TOLERANCE_MS", "1000", async () => {
      const result = await runOrderingDimension({
        db: repository.db,
        window_start: WINDOW_START,
        window_end: WINDOW_END
      });

      const finding = getDriftFinding(result);

      assert.equal(result.status, "fail");
      assert.equal(finding.mismatch_count, 1);
      assert.equal(finding.payload?.delta_ms, 1200);
    });
  } finally {
    repository.close();
  }
});

test("runOrderingDimension falls back to the default tolerance when env is 0", async () => {
  await withEnv("VEGA_RECONCILIATION_ORDERING_TOLERANCE_MS", "0", async () => {
    const result = await runOrderingDimensionFor1200MsDrift();

    assert.equal(result.status, "pass");
    assert.equal(result.findings.every((finding) => finding.status === "pass"), true);
  });
});

test("runOrderingDimension falls back to the default tolerance when env is negative", async () => {
  await withEnv("VEGA_RECONCILIATION_ORDERING_TOLERANCE_MS", "-500", async () => {
    const result = await runOrderingDimensionFor1200MsDrift();

    assert.equal(result.status, "pass");
    assert.equal(result.findings.every((finding) => finding.status === "pass"), true);
  });
});

test("runOrderingDimension falls back to the default tolerance when arg is 0", async () => {
  const result = await runOrderingDimensionFor1200MsDrift({ tolerance_ms: 0 });

  assert.equal(result.status, "pass");
  assert.equal(result.findings.every((finding) => finding.status === "pass"), true);
});

test("runOrderingDimension treats positive and negative drift symmetrically", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("44444444-4444-4444-8444-444444444444"));
    repository.createMemory(createMemory("55555555-5555-4555-8555-555555555555"));
    insertDecisionEnvelope(repository, "44444444-4444-4444-8444-444444444444");
    insertDecisionEnvelope(repository, "55555555-5555-4555-8555-555555555555");
    setReceivedAt(repository, "44444444-4444-4444-8444-444444444444", "2026-04-20T11:59:53.000Z");
    setReceivedAt(repository, "55555555-5555-4555-8555-555555555555", "2026-04-20T12:00:07.000Z");

    const result = await runOrderingDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    const finding = getDriftFinding(result);
    const sampleIds = new Set(finding.sample_ids ?? []);

    assert.equal(result.status, "fail");
    assert.equal(finding.mismatch_count, 2);
    assert.equal(sampleIds.has("44444444-4444-4444-8444-444444444444"), true);
    assert.equal(sampleIds.has("55555555-5555-4555-8555-555555555555"), true);
  } finally {
    repository.close();
  }
});

test("runOrderingDimension caps sample IDs at ten", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);

    for (let index = 0; index < 12; index += 1) {
      const id = `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`;
      repository.createMemory(createMemory(id));
      insertDecisionEnvelope(repository, id);
      setReceivedAt(repository, id, `2026-04-20T12:00:${String(index + 10).padStart(2, "0")}.000Z`);
    }

    const result = await runOrderingDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    const finding = getDriftFinding(result);

    assert.equal(result.status, "fail");
    assert.equal(finding.mismatch_count, 12);
    assert.equal((finding.sample_ids ?? []).length, 10);
  } finally {
    repository.close();
  }
});
