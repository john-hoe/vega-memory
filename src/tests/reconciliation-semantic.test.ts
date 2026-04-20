import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseAdapter } from "../db/adapter.js";
import { Repository } from "../db/repository.js";
import { applyRawInboxMigration, insertRawEvent } from "../ingestion/raw-inbox.js";
import { ReconciliationOrchestrator } from "../reconciliation/orchestrator.js";
import { runSemanticDimension } from "../reconciliation/semantic-dimension.js";

const WINDOW_START = Date.parse("2026-04-20T00:00:00.000Z");
const WINDOW_END = Date.parse("2026-04-21T00:00:00.000Z");

function createMemory(id: string, content = `Content ${id}`) {
  return {
    id,
    tenant_id: null,
    type: "decision" as const,
    project: "vega-memory",
    title: `Memory ${id}`,
    content,
    summary: null,
    embedding: null,
    importance: 0.5,
    source: "explicit" as const,
    tags: ["reconciliation"],
    created_at: "2026-04-20T12:00:00.000Z",
    updated_at: "2026-04-20T12:00:00.000Z",
    accessed_at: "2026-04-20T12:00:00.000Z",
    status: "active" as const,
    verified: "unverified" as const,
    scope: "project" as const,
    accessed_projects: ["vega-memory"],
    source_context: null
  };
}

function insertDecisionEnvelope(
  repository: Repository,
  eventId: string,
  content = `Content ${eventId}`
): void {
  insertRawEvent(repository.db, {
    schema_version: "1.0",
    event_id: eventId,
    surface: "api",
    session_id: "session-1",
    thread_id: null,
    project: "vega-memory",
    cwd: null,
    host_timestamp: "2026-04-20T12:00:00.000Z",
    role: "system",
    event_type: "decision",
    payload: {
      memory_type: "decision",
      title: `Envelope ${eventId}`,
      content,
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

function getMismatchFinding(result: Awaited<ReturnType<typeof runSemanticDimension>>) {
  const finding = result.findings.find((entry) => entry.status === "fail");
  assert.ok(finding, "expected a fail finding");
  return finding;
}

function createThrowingAdapter(base: DatabaseAdapter, match: string): DatabaseAdapter {
  return {
    run: base.run.bind(base),
    get: base.get.bind(base),
    all: base.all.bind(base),
    exec: base.exec.bind(base),
    prepare(sql) {
      if (sql.includes(match)) {
        throw new Error("semantic boom");
      }

      return base.prepare(sql);
    },
    transaction: base.transaction.bind(base),
    close: base.close.bind(base),
    isPostgres: base.isPostgres
  };
}

test("runSemanticDimension returns pass when sampled content hashes match", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("11111111-1111-4111-8111-111111111111"));
    insertDecisionEnvelope(repository, "11111111-1111-4111-8111-111111111111");

    const result = await runSemanticDimension({
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

test("runSemanticDimension detects a content hash mismatch", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("22222222-2222-4222-8222-222222222222", "Alpha content"));
    insertDecisionEnvelope(repository, "22222222-2222-4222-8222-222222222222", "Beta content");

    const result = await runSemanticDimension({
      db: repository.db,
      window_start: WINDOW_START,
      window_end: WINDOW_END
    });

    const finding = getMismatchFinding(result);

    assert.equal(result.status, "fail");
    assert.equal(finding.mismatch_count, 1);
    assert.deepEqual(finding.sample_ids, ["22222222-2222-4222-8222-222222222222"]);
    assert.deepEqual(finding.payload, {
      mismatch_type: "content_hash_mismatch",
      sample_ids: ["22222222-2222-4222-8222-222222222222"],
      memory_content_snippet: "Alpha content",
      envelope_content_snippet: "Beta content"
    });
  } finally {
    repository.close();
  }
});

test("runSemanticDimension respects VEGA_RECONCILIATION_SEMANTIC_SAMPLE_SIZE", async () => {
  const repository = new Repository(":memory:");
  const originalRandom = Math.random;

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("33333333-3333-4333-8333-333333333333", "Mismatch A"));
    repository.createMemory(createMemory("44444444-4444-4444-8444-444444444444", "Mismatch B"));
    insertDecisionEnvelope(repository, "33333333-3333-4333-8333-333333333333", "Other A");
    insertDecisionEnvelope(repository, "44444444-4444-4444-8444-444444444444", "Other B");
    Math.random = () => 0;

    await withEnv("VEGA_RECONCILIATION_SEMANTIC_SAMPLE_SIZE", "1", async () => {
      const result = await runSemanticDimension({
        db: repository.db,
        window_start: WINDOW_START,
        window_end: WINDOW_END
      });

      const finding = getMismatchFinding(result);

      assert.equal(result.status, "fail");
      assert.equal(finding.mismatch_count, 1);
      assert.equal((finding.sample_ids ?? []).length, 1);
    });
  } finally {
    Math.random = originalRandom;
    repository.close();
  }
});

test("runSemanticDimension caps sample IDs at ten", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);

    for (let index = 0; index < 12; index += 1) {
      const id = `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`;
      repository.createMemory(createMemory(id, `Memory ${id}`));
      insertDecisionEnvelope(repository, id, `Envelope ${id}`);
    }

    await withEnv("VEGA_RECONCILIATION_SEMANTIC_SAMPLE_SIZE", "50", async () => {
      const result = await runSemanticDimension({
        db: repository.db,
        window_start: WINDOW_START,
        window_end: WINDOW_END
      });

      const finding = getMismatchFinding(result);

      assert.equal(result.status, "fail");
      assert.equal(finding.mismatch_count, 12);
      assert.equal((finding.sample_ids ?? []).length, 10);
    });
  } finally {
    repository.close();
  }
});

test("runSemanticDimension returns error status on payload_json parse failure", async () => {
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

    const result = await runSemanticDimension({
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

test("orchestrator isolates a thrown semantic dimension from other dimensions", async () => {
  const repository = new Repository(":memory:");

  try {
    applyRawInboxMigration(repository.db);
    repository.createMemory(createMemory("77777777-7777-4777-8777-777777777777"));
    insertDecisionEnvelope(repository, "77777777-7777-4777-8777-777777777777");
    repository.db.run(
      "UPDATE raw_inbox SET received_at = ? WHERE event_id = ?",
      "2026-04-20T12:00:00.000Z",
      "77777777-7777-4777-8777-777777777777"
    );

    const orchestrator = new ReconciliationOrchestrator({
      db: createThrowingAdapter(repository.db, "semantic_payload_json"),
      now: () => WINDOW_END
    });

    const report = await orchestrator.run({
      window_start: WINDOW_START,
      window_end: WINDOW_END,
      dimensions: ["shape", "semantic", "ordering"]
    });

    assert.deepEqual(
      report.dimensions.map((dimension) => [dimension.dimension, dimension.status]),
      [
        ["shape", "pass"],
        ["semantic", "error"],
        ["ordering", "pass"]
      ]
    );
    assert.match(report.dimensions[1]?.error ?? "", /semantic boom/i);
  } finally {
    repository.close();
  }
});
