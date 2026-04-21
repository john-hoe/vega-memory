import assert from "node:assert/strict";
import test from "node:test";

import type { LogRecord } from "../core/logging/index.js";
import { Repository } from "../db/repository.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  CANDIDATE_MEMORIES_TABLE,
  applyCandidateMemoryMigration
} from "../db/candidate-memory-migration.js";
import { createCandidateRepository } from "../db/candidate-repository.js";

function createCandidateInput(
  overrides: Partial<Parameters<ReturnType<typeof createCandidateRepository>["create"]>[0]> = {}
): Parameters<ReturnType<typeof createCandidateRepository>["create"]>[0] {
  return {
    content: "candidate memory",
    type: "observation",
    project: "vega-memory",
    tags: ["wave-4"],
    metadata: {
      source: "test"
    },
    extraction_source: "manual",
    extraction_confidence: 0.9,
    visibility_gated: true,
    ...overrides
  };
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

test("create returns a full candidate record with generated id and timestamps", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);

    const record = repository.create(createCandidateInput());

    assert.match(
      record.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    );
    assert.equal(record.promotion_score, 0);
    assert.equal(record.candidate_state, "pending");
    assert.equal(typeof record.created_at, "number");
    assert.equal(record.updated_at, record.created_at);
    assert.deepEqual(repository.findById(record.id), record);
    assert.equal(repository.size(), 1);
  } finally {
    db.close();
  }
});

test("findById returns undefined for unknown candidate ids", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);

    assert.equal(repository.findById("missing-candidate"), undefined);
  } finally {
    db.close();
  }
});

test("list sorts by created_at desc and supports project, type, and since filters", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyCandidateMemoryMigration(db);
    const repository = createCandidateRepository(db);

    db.run(
      `INSERT INTO ${CANDIDATE_MEMORIES_TABLE} (
        id,
        content,
        type,
        project,
        tags,
        metadata,
        extraction_source,
      extraction_confidence,
      promotion_score,
      visibility_gated,
      candidate_state,
      created_at,
      updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "cand-1",
      "first",
      "observation",
      "vega-memory",
      JSON.stringify(["a"]),
      JSON.stringify({ ordinal: 1 }),
      "manual",
      0.1,
      0,
      1,
      "held",
      1_000,
      1_000
    );
    db.run(
      `INSERT INTO ${CANDIDATE_MEMORIES_TABLE} (
        id,
        content,
        type,
        project,
        tags,
        metadata,
        extraction_source,
      extraction_confidence,
      promotion_score,
      visibility_gated,
      candidate_state,
      created_at,
      updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "cand-2",
      "second",
      "pitfall",
      "vega-memory",
      JSON.stringify(["b"]),
      JSON.stringify({ ordinal: 2 }),
      "manual",
      0.2,
      0,
      0,
      "ready",
      2_000,
      2_000
    );
    db.run(
      `INSERT INTO ${CANDIDATE_MEMORIES_TABLE} (
        id,
        content,
        type,
        project,
        tags,
        metadata,
        extraction_source,
      extraction_confidence,
      promotion_score,
      visibility_gated,
      candidate_state,
      created_at,
      updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "cand-3",
      "third",
      "observation",
      "other-project",
      JSON.stringify(["c"]),
      JSON.stringify({ ordinal: 3 }),
      "manual",
      null,
      0,
      0,
      "discarded",
      3_000,
      3_000
    );

    assert.deepEqual(repository.list(), [
      {
        id: "cand-3",
        content: "third",
        type: "observation",
        project: "other-project",
        tags: ["c"],
        metadata: { ordinal: 3 },
        extraction_source: "manual",
        extraction_confidence: null,
        promotion_score: 0,
        visibility_gated: false,
        candidate_state: "discarded",
        source_kind: "vega_memory",
        created_at: 3_000,
        updated_at: 3_000
      },
      {
        id: "cand-2",
        content: "second",
        type: "pitfall",
        project: "vega-memory",
        tags: ["b"],
        metadata: { ordinal: 2 },
        extraction_source: "manual",
        extraction_confidence: 0.2,
        promotion_score: 0,
        visibility_gated: false,
        candidate_state: "ready",
        source_kind: "vega_memory",
        created_at: 2_000,
        updated_at: 2_000
      },
      {
        id: "cand-1",
        content: "first",
        type: "observation",
        project: "vega-memory",
        tags: ["a"],
        metadata: { ordinal: 1 },
        extraction_source: "manual",
        extraction_confidence: 0.1,
        promotion_score: 0,
        visibility_gated: true,
        candidate_state: "held",
        source_kind: "vega_memory",
        created_at: 1_000,
        updated_at: 1_000
      }
    ]);
    assert.deepEqual(
      repository.list({ project: "vega-memory" }).map((record) => record.id),
      ["cand-2", "cand-1"]
    );
    assert.deepEqual(
      repository.list({ type: "observation" }).map((record) => record.id),
      ["cand-3", "cand-1"]
    );
    assert.deepEqual(
      repository.list({ since: 2_000 }).map((record) => record.id),
      ["cand-3", "cand-2"]
    );
  } finally {
    db.close();
  }
});

test("delete returns true on success and false for unknown ids", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    const record = repository.create(createCandidateInput());

    assert.equal(repository.delete(record.id), true);
    assert.equal(repository.findById(record.id), undefined);
    assert.equal(repository.delete(record.id), false);
    assert.equal(repository.size(), 0);
  } finally {
    db.close();
  }
});

test("updateState supports pending to held/ready/discarded transitions and idempotent writes", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    const record = repository.create(createCandidateInput());

    assert.equal(repository.updateState(record.id, "pending"), true);
    assert.equal(repository.findById(record.id)?.candidate_state, "pending");

    assert.equal(repository.updateState(record.id, "held"), true);
    assert.equal(repository.findById(record.id)?.candidate_state, "held");

    assert.equal(repository.updateState(record.id, "ready"), true);
    assert.equal(repository.findById(record.id)?.candidate_state, "ready");

    assert.equal(repository.updateState(record.id, "discarded"), true);
    assert.equal(repository.findById(record.id)?.candidate_state, "discarded");

    assert.equal(repository.updateState("missing-candidate", "held"), false);
  } finally {
    db.close();
  }
});

test("tags and metadata JSON fields round-trip correctly", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    const record = repository.create(
      createCandidateInput({
        tags: ["wave-4", "candidate"],
        metadata: {
          rank: 7,
          nested: {
            enabled: true
          }
        },
        visibility_gated: false
      })
    );

    assert.deepEqual(repository.findById(record.id)?.tags, ["wave-4", "candidate"]);
    assert.deepEqual(repository.findById(record.id)?.metadata, {
      rank: 7,
      nested: {
        enabled: true
      }
    });
    assert.equal(repository.findById(record.id)?.visibility_gated, false);
  } finally {
    db.close();
  }
});

test("corrupt JSON rows are skipped with warning logs instead of throwing", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyCandidateMemoryMigration(db);
    const repository = createCandidateRepository(db);

    db.run(
      `INSERT INTO ${CANDIDATE_MEMORIES_TABLE} (
        id,
        content,
        type,
        project,
        tags,
        metadata,
        extraction_source,
        extraction_confidence,
        promotion_score,
        visibility_gated,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "bad-json",
      "broken row",
      "observation",
      "vega-memory",
      "{bad-json",
      JSON.stringify({ ok: true }),
      "manual",
      0.4,
      0,
      1,
      1_000,
      1_000
    );

    const { result, logs } = captureStructuredLogs(() => ({
      find: repository.findById("bad-json"),
      list: repository.list()
    }));

    assert.equal(result.find, undefined);
    assert.deepEqual(result.list, []);
    assert.ok(
      logs.some(
        (record) =>
          record.level === "warn" &&
          record.message === "Candidate repository row parse failed"
      )
    );
  } finally {
    db.close();
  }
});

test("candidate migration is idempotent", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    assert.doesNotThrow(() => applyCandidateMemoryMigration(db));
    assert.doesNotThrow(() => applyCandidateMemoryMigration(db));
  } finally {
    db.close();
  }
});

test("candidate repository storage is physically isolated from promoted memories", () => {
  const repository = new Repository(":memory:");

  try {
    const candidateRepository = createCandidateRepository(repository.db);
    const candidate = candidateRepository.create(createCandidateInput());

    assert.equal(repository.getMemory(candidate.id), null);
    assert.deepEqual(candidateRepository.findById(candidate.id)?.content, "candidate memory");
  } finally {
    repository.close();
  }
});

test("candidate list pushes visibility_gated filter into SQL so LIMIT applies after filter", () => {
  // Regression for round-6 #1: the adapter used to filter after LIMIT which
  // dropped visible rows whenever gated rows were newer. The fix pushes the
  // filter into the WHERE clause at repository level.
  const db = new SQLiteAdapter(":memory:");
  let clock = 1000;

  try {
    const repository = createCandidateRepository(db, { now: () => (clock += 10) });
    repository.create(createCandidateInput({ content: "visible older", visibility_gated: false }));
    for (let i = 0; i < 3; i += 1) {
      repository.create(createCandidateInput({ content: `gated newer ${i}`, visibility_gated: true }));
    }

    // Without visibility_gated filter, top 2 by created_at DESC are both gated rows.
    const unfiltered = repository.list({ limit: 2 });
    assert.equal(unfiltered.length, 2);
    assert.ok(unfiltered.every((r) => r.visibility_gated));

    // With filter, the single visible row surfaces even at limit=2.
    const filtered = repository.list({ limit: 2, visibility_gated: false });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.content, "visible older");
    assert.equal(filtered[0]?.visibility_gated, false);
  } finally {
    db.close();
  }
});

test("candidate list can filter by state without changing the default unfiltered result", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    const pending = repository.create(createCandidateInput({ content: "pending" }));
    const ready = repository.create(createCandidateInput({ content: "ready" }));
    const discarded = repository.create(createCandidateInput({ content: "discarded" }));

    repository.updateState(ready.id, "ready");
    repository.updateState(discarded.id, "discarded");

    assert.equal(repository.list().length, 3);
    assert.deepEqual(
      repository.list({ state: "ready" }).map((record) => record.id),
      [ready.id]
    );
    assert.equal(repository.list({ state: "ready" })[0]?.candidate_state, "ready");
    assert.deepEqual(
      repository.list({ state: "discarded" }).map((record) => record.id),
      [discarded.id]
    );
    assert.equal(repository.list({ state: "discarded" })[0]?.candidate_state, "discarded");
    assert.equal(repository.list({ state: "held" }).length, 0);
    assert.deepEqual(
      repository.list({ state: "pending" }).map((record) => record.id),
      [pending.id]
    );
    assert.equal(repository.list({ state: "pending" })[0]?.candidate_state, "pending");
  } finally {
    db.close();
  }
});

test("candidate migration adds missing columns on a pre-existing partial schema", () => {
  // Regression for round-6 #4: the prior migration created the promotion_score
  // index unconditionally. If an older deployment had candidate_memories
  // without promotion_score / visibility_gated, the index creation would throw
  // "no such column".
  const db = new SQLiteAdapter(":memory:");

  try {
    // Pre-seed a partial old-shape table that predates promotion_score +
    // visibility_gated + candidate_state.
    db.exec(`
      CREATE TABLE ${CANDIDATE_MEMORIES_TABLE} (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        project TEXT,
        tags TEXT,
        metadata TEXT,
        extraction_source TEXT NOT NULL,
        extraction_confidence REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.run(
      `INSERT INTO ${CANDIDATE_MEMORIES_TABLE}
        (id, content, type, project, tags, metadata, extraction_source, extraction_confidence, created_at, updated_at)
        VALUES ('legacy-1', 'old candidate', 'observation', 'vega-memory', '[]', '{}', 'manual', 0.5, 1, 1)`
    );

    assert.doesNotThrow(() => applyCandidateMemoryMigration(db));

    // Legacy rows get defaults for the added columns.
    const row = db.get<{
      promotion_score: number;
      visibility_gated: number;
      candidate_state: string;
    }>(
      `SELECT promotion_score, visibility_gated, candidate_state FROM ${CANDIDATE_MEMORIES_TABLE} WHERE id = ?`,
      "legacy-1"
    );
    assert.equal(row?.promotion_score, 0);
    assert.equal(row?.visibility_gated, 1);
    assert.equal(row?.candidate_state, "pending");

    // New inserts still work after migration.
    const repository = createCandidateRepository(db);
    const fresh = repository.create(createCandidateInput({ content: "fresh after migration" }));
    assert.equal(repository.findById(fresh.id)?.content, "fresh after migration");
  } finally {
    db.close();
  }
});
