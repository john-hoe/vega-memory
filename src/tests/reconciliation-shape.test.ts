import assert from "node:assert/strict";
import test from "node:test";

import type { Memory } from "../core/types.js";
import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import { Repository } from "../db/repository.js";
import { applyRawInboxMigration, insertRawEvent } from "../ingestion/raw-inbox.js";
import { runShapeDimension } from "../reconciliation/shape-dimension.js";

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

function insertDecisionEnvelope(
  repository: Repository,
  eventId: string,
  options: {
    payload?: Record<string, unknown>;
    project?: string | null;
    event_type?: "decision" | "state_change";
    source_kind?: HostEventEnvelopeV1["source_kind"] | null;
  } = {}
): void {
  insertRawEvent(repository.db, {
    schema_version: "1.0",
    event_id: eventId,
    surface: "api",
    session_id: "session-1",
    thread_id: null,
    project: options.project ?? "vega-memory",
    cwd: null,
    host_timestamp: "2026-04-20T12:00:00.000Z",
    role: "system",
    event_type: options.event_type ?? "decision",
    payload: {
      memory_type: "decision",
      title: `Envelope ${eventId}`,
      content: `Content ${eventId}`,
      summary: null,
      tags: ["reconciliation"],
      ...options.payload
    },
    safety: {
      redacted: false,
      categories: []
    },
    artifacts: [],
    source_kind: options.source_kind ?? "vega_memory"
  });
}

function getSingleFinding(result: Awaited<ReturnType<typeof runShapeDimension>>) {
  const finding = result.findings.find((entry) => entry.status !== "pass");
  assert.ok(finding, "expected a non-pass finding");
  return finding;
}

test("runShapeDimension returns pass when invariant fields match", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("11111111-1111-4111-8111-111111111111"));
    insertDecisionEnvelope(repository, "11111111-1111-4111-8111-111111111111");

    const result = await runShapeDimension({
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

test("runShapeDimension emits field_missing when an invariant payload field is absent", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("22222222-2222-4222-8222-222222222222"));
    insertDecisionEnvelope(repository, "22222222-2222-4222-8222-222222222222");
    repository.db.run(
      "UPDATE raw_inbox SET payload_json = ? WHERE event_id = ?",
      JSON.stringify({
        memory_type: "decision",
        title: "Envelope 22222222-2222-4222-8222-222222222222",
        summary: null,
        tags: ["reconciliation"]
      }),
      "22222222-2222-4222-8222-222222222222"
    );

    const result = await runShapeDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    const finding = getSingleFinding(result);

    assert.equal(result.status, "fail");
    assert.equal(finding.event_type, "decision");
    assert.equal(finding.mismatch_count, 1);
    assert.deepEqual(finding.sample_ids, ["22222222-2222-4222-8222-222222222222"]);
    assert.deepEqual(finding.payload, {
      mismatch_type: "field_missing",
      field_name: "content",
      sample_ids: ["22222222-2222-4222-8222-222222222222"]
    });
  } finally {
    repository.close();
  }
});

test("runShapeDimension emits value_mismatch when an invariant field differs", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("33333333-3333-4333-8333-333333333333"));
    insertDecisionEnvelope(repository, "33333333-3333-4333-8333-333333333333", {
      payload: {
        content: "Different content"
      }
    });

    const result = await runShapeDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    const finding = getSingleFinding(result);

    assert.equal(result.status, "fail");
    assert.equal(finding.mismatch_count, 1);
    assert.deepEqual(finding.payload, {
      mismatch_type: "value_mismatch",
      field_name: "content",
      sample_ids: ["33333333-3333-4333-8333-333333333333"]
    });
  } finally {
    repository.close();
  }
});

test("runShapeDimension ignores non-invariant differences", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("44444444-4444-4444-8444-444444444444"));
    insertDecisionEnvelope(repository, "44444444-4444-4444-8444-444444444444", {
      payload: {
        title: "Changed title"
      }
    });
    repository.db.run(
      "UPDATE memories SET access_count = ? WHERE id = ?",
      99,
      "44444444-4444-4444-8444-444444444444"
    );

    const result = await runShapeDimension({
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

test("runShapeDimension caps sample IDs at ten per finding row", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);

    for (let index = 0; index < 12; index += 1) {
      const id = `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`;
      repository.createMemory(createMemory(id));
      insertDecisionEnvelope(repository, id, {
        payload: {
          content: `Different ${id}`
        }
      });
    }

    const result = await runShapeDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    const finding = getSingleFinding(result);
    const sampleIds = finding.sample_ids ?? [];

    assert.equal(result.status, "fail");
    assert.equal(finding.mismatch_count, 12);
    assert.equal(sampleIds.length, 10);
  } finally {
    repository.close();
  }
});

test("runShapeDimension returns error status when payload_json cannot be parsed", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("66666666-6666-4666-8666-666666666666"));
    insertDecisionEnvelope(repository, "66666666-6666-4666-8666-666666666666");
    repository.db.run(
      "UPDATE raw_inbox SET payload_json = ? WHERE event_id = ?",
      "{",
      "66666666-6666-4666-8666-666666666666"
    );

    const result = await runShapeDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /payload_json/i);
    assert.equal(result.findings.some((finding) => finding.status === "error"), true);
  } finally {
    repository.close();
  }
});
