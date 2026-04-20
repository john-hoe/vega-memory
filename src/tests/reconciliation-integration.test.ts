import assert from "node:assert/strict";
import test from "node:test";

import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { createShadowAwareRepository } from "../db/shadow-aware-repository.js";
import { applyRawInboxMigration, insertRawEvent } from "../ingestion/raw-inbox.js";
import { createShadowWriter } from "../ingestion/shadow-writer.js";
import {
  listReconciliationFindings,
  type ReconciliationFindingRow
} from "../reconciliation/findings-store.js";
import type { ReconciliationDimension, ReconciliationReport } from "../reconciliation/report.js";
import { ReconciliationOrchestrator } from "../reconciliation/orchestrator.js";

const SHADOW_DUAL_WRITE_FLAG = "VEGA_SHADOW_DUAL_WRITE";
const SEMANTIC_SAMPLE_SIZE_ENV = "VEGA_RECONCILIATION_SEMANTIC_SAMPLE_SIZE";
const RETENTION_DAYS_ENV = "VEGA_RECONCILIATION_RETENTION_DAYS";
const RETENTION_MAX_ROWS_ENV = "VEGA_RECONCILIATION_RETENTION_MAX_ROWS";

const WINDOW_A_START = Date.parse("2026-04-20T00:00:00.000Z");
const WINDOW_B_START = Date.parse("2026-04-21T00:00:00.000Z");
const WINDOW_C1_START = Date.parse("2026-04-22T00:00:00.000Z");
const WINDOW_C2_START = Date.parse("2026-04-23T00:00:00.000Z");
const WINDOW_C3_START = Date.parse("2026-04-24T00:00:00.000Z");
const WINDOW_C4_START = Date.parse("2026-04-25T00:00:00.000Z");

function createMemory(
  id: string,
  createdAt: string,
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> {
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
    source_context: {
      actor: "tester",
      channel: "cli",
      device_id: "vega-memory",
      device_name: "Vega Memory",
      platform: "server",
      session_id: "session-1"
    },
    ...overrides
  };
}

function createPayload(eventId: string, content = `Content ${eventId}`): Record<string, unknown> {
  return {
    memory_type: "decision",
    title: `Memory ${eventId}`,
    content,
    summary: null,
    tags: ["reconciliation"]
  };
}

function createHarness() {
  const repository = new Repository(":memory:");
  applyRawInboxMigration(repository.db);

  return {
    repository,
    shadowRepository: createShadowAwareRepository(
      repository,
      createShadowWriter({ db: repository.db })
    ),
    close() {
      repository.close();
    }
  };
}

function insertDecisionEnvelope(
  repository: Repository,
  eventId: string,
  hostTimestamp: string,
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
    host_timestamp: hostTimestamp,
    role: "system",
    event_type: "decision",
    payload: createPayload(eventId, content),
    safety: {
      redacted: false,
      categories: []
    },
    artifacts: [],
    source_kind: "vega_memory"
  });
}

function updateEnvelopePayload(
  repository: Repository,
  eventId: string,
  payload: Record<string, unknown>
): void {
  repository.db.run(
    "UPDATE raw_inbox SET payload_json = ? WHERE event_id = ?",
    JSON.stringify(payload),
    eventId
  );
}

function setReceivedAt(repository: Repository, eventId: string, receivedAt: string): void {
  repository.db.run(
    "UPDATE raw_inbox SET received_at = ? WHERE event_id = ?",
    receivedAt,
    eventId
  );
}

function getDimension(
  report: ReconciliationReport,
  dimension: ReconciliationDimension
) {
  const entry = report.dimensions.find((item) => item.dimension === dimension);
  assert.ok(entry, `missing ${dimension} dimension`);
  return entry;
}

function getStoredFinding(
  rows: ReconciliationFindingRow[],
  args: {
    dimension: ReconciliationDimension;
    status?: string;
    event_type?: string;
    direction?: string;
  }
) {
  const row = rows.find(
    (entry) =>
      entry.dimension === args.dimension &&
      (args.status === undefined || entry.status === args.status) &&
      (args.event_type === undefined || entry.event_type === args.event_type) &&
      (args.direction === undefined || entry.direction === args.direction)
  );

  assert.ok(
    row,
    `missing stored finding for ${args.dimension}/${args.status ?? "*"}/${args.event_type ?? "*"}/${args.direction ?? "*"}`
  );
  return row;
}

function countReportFindings(report: ReconciliationReport): number {
  return report.dimensions.reduce((total, dimension) => total + dimension.findings.length, 0);
}

async function withEnv<T>(
  name: string,
  value: string | undefined,
  run: () => Promise<T> | T
): Promise<T> {
  const previous = process.env[name];

  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function runWindow(
  repository: Repository,
  windowStart: number,
  options: {
    now?: number;
    dimensions?: ReconciliationDimension[];
  } = {}
) {
  const windowEnd = windowStart + 86_400_000;
  const orchestrator = new ReconciliationOrchestrator({
    db: repository.db,
    now: () => options.now ?? windowEnd
  });

  return orchestrator.run({
    window_start: windowStart,
    window_end: windowEnd,
    ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions })
  });
}

function seedShapeMismatch(
  shadowRepository: Repository,
  repository: Repository,
  id: string,
  createdAt: string,
  envelopeContent: string
): void {
  shadowRepository.createMemory(createMemory(id, createdAt));
  updateEnvelopePayload(repository, id, createPayload(id, envelopeContent));
}

test("aggregate run reports 5-dimension divergence without corrupting the derived stub", async () => {
  const harness = createHarness();

  try {
    await withEnv(SHADOW_DUAL_WRITE_FLAG, "true", async () => {
      harness.repository.createMemory(
        createMemory(
          "11111111-1111-4111-8111-111111111111",
          "2026-04-20T12:00:00.000Z"
        )
      );

      harness.shadowRepository.createMemory(
        createMemory(
          "22222222-2222-4222-8222-222222222222",
          "2026-04-20T12:05:00.000Z"
        )
      );
      harness.shadowRepository.createMemory(
        createMemory(
          "33333333-3333-4333-8333-333333333333",
          "2026-04-20T12:10:00.000Z"
        )
      );

      updateEnvelopePayload(
        harness.repository,
        "22222222-2222-4222-8222-222222222222",
        createPayload("22222222-2222-4222-8222-222222222222", "Shadow mismatch content")
      );
      setReceivedAt(
        harness.repository,
        "22222222-2222-4222-8222-222222222222",
        "2026-04-20T12:05:00.000Z"
      );
      setReceivedAt(
        harness.repository,
        "33333333-3333-4333-8333-333333333333",
        "2026-04-20T12:10:10.000Z"
      );
      insertDecisionEnvelope(
        harness.repository,
        "44444444-4444-4444-8444-444444444444",
        "2026-04-20T12:15:00.000Z"
      );

      const report = await runWindow(harness.repository, WINDOW_A_START, {
        dimensions: ["count", "shape", "semantic", "ordering", "derived"]
      });
      const storedRows = listReconciliationFindings(harness.repository.db, {
        run_id: report.run_id
      });

      assert.deepEqual(report.totals, {
        pass: 0,
        fail: 4,
        not_implemented: 1,
        error: 0
      });

      const count = getDimension(report, "count");
      const derived = getDimension(report, "derived");
      assert.equal(count.status, "fail");
      assert.equal(getDimension(report, "shape").status, "fail");
      assert.equal(getDimension(report, "semantic").status, "fail");
      assert.equal(getDimension(report, "ordering").status, "fail");
      assert.equal(derived.status, "not_implemented");

      const forwardMiss = count.findings.find(
        (finding) =>
          finding.direction === "forward" &&
          finding.event_type === "decision" &&
          (finding.sample_ids ?? []).includes("11111111-1111-4111-8111-111111111111")
      );
      const reverseOrphan = count.findings.find(
        (finding) =>
          finding.direction === "reverse" &&
          finding.event_type === "decision" &&
          (finding.sample_ids ?? []).includes("44444444-4444-4444-8444-444444444444")
      );

      assert.ok(forwardMiss, "expected forward miss sample for memory #1");
      assert.ok(reverseOrphan, "expected reverse orphan sample");

      const shapeFinding = getStoredFinding(storedRows, {
        dimension: "shape",
        status: "fail",
        event_type: "decision"
      });
      assert.equal(shapeFinding.payload.mismatch_type, "value_mismatch");
      assert.equal(shapeFinding.payload.field_name, "content");
      assert.deepEqual(shapeFinding.payload.sample_ids, [
        "22222222-2222-4222-8222-222222222222"
      ]);

      const semanticFinding = getStoredFinding(storedRows, {
        dimension: "semantic",
        status: "fail",
        event_type: "decision"
      });
      assert.equal(semanticFinding.payload.mismatch_type, "content_hash_mismatch");
      assert.deepEqual(semanticFinding.payload.sample_ids, [
        "22222222-2222-4222-8222-222222222222"
      ]);

      const orderingFinding = getStoredFinding(storedRows, {
        dimension: "ordering",
        status: "fail",
        event_type: "decision"
      });
      assert.equal(orderingFinding.payload.mismatch_type, "timestamp_drift");
      assert.equal(typeof orderingFinding.payload.delta_ms, "number");
      assert.equal((orderingFinding.payload.delta_ms as number) >= 10_000, true);

      const derivedFinding = getStoredFinding(storedRows, {
        dimension: "derived",
        status: "not_implemented"
      });
      assert.equal(derivedFinding.payload.status, "not_implemented");
    });
  } finally {
    harness.close();
  }
});

test("aggregate run isolates a semantic error triggered by DB-level corruption", async () => {
  const harness = createHarness();

  try {
    await withEnv(SHADOW_DUAL_WRITE_FLAG, "true", async () => {
      harness.shadowRepository.createMemory(
        createMemory(
          "55555555-5555-4555-8555-555555555555",
          "2026-04-21T12:00:00.000Z"
        )
      );
      updateEnvelopePayload(harness.repository, "55555555-5555-4555-8555-555555555555", {
        memory_type: "decision",
        title: "Memory 55555555-5555-4555-8555-555555555555",
        content: 42,
        summary: null,
        tags: ["reconciliation"]
      });
      setReceivedAt(
        harness.repository,
        "55555555-5555-4555-8555-555555555555",
        "2026-04-21T12:00:00.000Z"
      );

      const report = await runWindow(harness.repository, WINDOW_B_START, {
        dimensions: ["count", "shape", "semantic", "ordering", "derived"]
      });
      const storedRows = listReconciliationFindings(harness.repository.db, {
        run_id: report.run_id
      });

      assert.deepEqual(
        report.dimensions.map((dimension) => [dimension.dimension, dimension.status]),
        [
          ["count", "pass"],
          ["shape", "fail"],
          ["semantic", "error"],
          ["ordering", "pass"],
          ["derived", "not_implemented"]
        ]
      );

      const semantic = getDimension(report, "semantic");
      assert.match(semantic.error ?? "", /payload_json\.content must be a string/i);

      const semanticFinding = getStoredFinding(storedRows, {
        dimension: "semantic",
        status: "error"
      });
      assert.match(String(semanticFinding.payload.error ?? ""), /payload_json\.content/i);
    });
  } finally {
    harness.close();
  }
});

test("findings storage matches per-run reports across multiple windows and prunes older runs", async () => {
  const harness = createHarness();

  try {
    await withEnv(SHADOW_DUAL_WRITE_FLAG, "true", async () => {
      seedShapeMismatch(
        harness.shadowRepository,
        harness.repository,
        "66666666-6666-4666-8666-666666666666",
        "2026-04-22T12:00:00.000Z",
        "Window C1 mismatch"
      );
      seedShapeMismatch(
        harness.shadowRepository,
        harness.repository,
        "77777777-7777-4777-8777-777777777777",
        "2026-04-23T12:00:00.000Z",
        "Window C2 mismatch"
      );
      seedShapeMismatch(
        harness.shadowRepository,
        harness.repository,
        "88888888-8888-4888-8888-888888888888",
        "2026-04-24T12:00:00.000Z",
        "Window C3 mismatch"
      );

      const firstReport = await runWindow(harness.repository, WINDOW_C1_START);
      const firstRows = listReconciliationFindings(harness.repository.db, {
        run_id: firstReport.run_id
      });
      assert.equal(firstRows.length, countReportFindings(firstReport));

      const secondReport = await runWindow(harness.repository, WINDOW_C2_START);
      const secondRows = listReconciliationFindings(harness.repository.db, {
        run_id: secondReport.run_id
      });
      assert.equal(secondRows.length, countReportFindings(secondReport));

      const thirdReport = await runWindow(harness.repository, WINDOW_C3_START);
      const thirdRows = listReconciliationFindings(harness.repository.db, {
        run_id: thirdReport.run_id
      });
      assert.equal(thirdRows.length, countReportFindings(thirdReport));

      const totalBeforePrune = listReconciliationFindings(harness.repository.db).length;
      assert.equal(
        totalBeforePrune,
        firstRows.length + secondRows.length + thirdRows.length
      );

      seedShapeMismatch(
        harness.shadowRepository,
        harness.repository,
        "99999999-9999-4999-8999-999999999999",
        "2026-04-25T12:00:00.000Z",
        "Window C4 mismatch"
      );

      await withEnv(RETENTION_DAYS_ENV, "30", async () => {
        await withEnv(RETENTION_MAX_ROWS_ENV, "1", async () => {
          const fourthReport = await runWindow(harness.repository, WINDOW_C4_START);
          const fourthRows = listReconciliationFindings(harness.repository.db, {
            run_id: fourthReport.run_id
          });

          assert.equal(fourthRows.length, countReportFindings(fourthReport));
          assert.equal(
            listReconciliationFindings(harness.repository.db, {
              run_id: firstReport.run_id
            }).length,
            0
          );
          assert.equal(
            listReconciliationFindings(harness.repository.db).length,
            fourthRows.length
          );
        });
      });
    });
  } finally {
    harness.close();
  }
});
