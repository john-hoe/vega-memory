import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { createCandidateRepository } from "../db/candidate-repository.js";

function createCandidateInput(
  overrides: Partial<Parameters<ReturnType<typeof createCandidateRepository>["create"]>[0]> = {}
): Parameters<ReturnType<typeof createCandidateRepository>["create"]>[0] {
  return {
    content: "candidate memory",
    type: "observation",
    project: "vega-memory",
    tags: ["wave-4"],
    metadata: { source: "test" },
    extraction_source: "manual",
    extraction_confidence: 0.9,
    visibility_gated: true,
    ...overrides
  };
}

test("raw_dedup_key round-trips through create and findById", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    const record = repository.create(
      createCandidateInput({ raw_dedup_key: "dedup-abc-123" })
    );

    assert.equal(record.raw_dedup_key, "dedup-abc-123");
    assert.equal(repository.findById(record.id)?.raw_dedup_key, "dedup-abc-123");
  } finally {
    db.close();
  }
});

test("raw_dedup_key defaults to null when not provided", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    const record = repository.create(createCandidateInput());

    assert.equal(record.raw_dedup_key, null);
    assert.equal(repository.findById(record.id)?.raw_dedup_key, null);
  } finally {
    db.close();
  }
});

test("findByRawDedupKey returns the most recent matching record", () => {
  const db = new SQLiteAdapter(":memory:");
  let clock = 1_000;

  try {
    const repository = createCandidateRepository(db, { now: () => (clock += 10) });
    const older = repository.create(
      createCandidateInput({ content: "older", raw_dedup_key: "shared-key" })
    );
    const newer = repository.create(
      createCandidateInput({ content: "newer", raw_dedup_key: "shared-key" })
    );

    const found = repository.findByRawDedupKey("shared-key");

    assert.equal(found?.id, newer.id);
    assert.equal(found?.content, "newer");
  } finally {
    db.close();
  }
});

test("findByRawDedupKey returns undefined for unknown key", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);

    assert.equal(repository.findByRawDedupKey("no-such-key"), undefined);
  } finally {
    db.close();
  }
});

test("list filters by raw_dedup_key", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    const a = repository.create(
      createCandidateInput({ content: "a", raw_dedup_key: "key-a" })
    );
    const b = repository.create(
      createCandidateInput({ content: "b", raw_dedup_key: "key-b" })
    );
    const c = repository.create(
      createCandidateInput({ content: "c", raw_dedup_key: null })
    );

    assert.deepEqual(
      repository.list({ raw_dedup_key: "key-a" }).map((r) => r.id),
      [a.id]
    );
    assert.deepEqual(
      repository.list({ raw_dedup_key: "key-b" }).map((r) => r.id),
      [b.id]
    );
    assert.deepEqual(
      repository.list({ raw_dedup_key: null }).map((r) => r.id),
      [c.id]
    );
  } finally {
    db.close();
  }
});

test("migration adds raw_dedup_key to pre-existing partial schema", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    db.exec(`
      CREATE TABLE candidate_memories (
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
      `INSERT INTO candidate_memories
        (id, content, type, project, tags, metadata, extraction_source, extraction_confidence, created_at, updated_at)
        VALUES ('legacy-1', 'old candidate', 'observation', 'vega-memory', '[]', '{}', 'manual', 0.5, 1, 1)`
    );

    const repository = createCandidateRepository(db);
    const legacy = repository.findById("legacy-1");

    assert.equal(legacy?.raw_dedup_key, null);

    const fresh = repository.create(
      createCandidateInput({ content: "fresh", raw_dedup_key: "fresh-key" })
    );

    assert.equal(fresh.raw_dedup_key, "fresh-key");
    assert.equal(repository.findByRawDedupKey("fresh-key")?.id, fresh.id);
  } finally {
    db.close();
  }
});

test("semantic_fingerprint round-trips through create and findById", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    const record = repository.create(
      createCandidateInput({ semantic_fingerprint: "semantic-abc-123" })
    );

    assert.equal(record.semantic_fingerprint, "semantic-abc-123");
    assert.equal(repository.findById(record.id)?.semantic_fingerprint, "semantic-abc-123");
  } finally {
    db.close();
  }
});

test("semantic_fingerprint defaults to null when not provided", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    const record = repository.create(createCandidateInput());

    assert.equal(record.semantic_fingerprint, null);
    assert.equal(repository.findById(record.id)?.semantic_fingerprint, null);
  } finally {
    db.close();
  }
});

test("findBySemanticFingerprint returns the most recent matching record", () => {
  const db = new SQLiteAdapter(":memory:");
  let clock = 1_000;

  try {
    const repository = createCandidateRepository(db, { now: () => (clock += 10) });
    const older = repository.create(
      createCandidateInput({ content: "older", semantic_fingerprint: "shared-semantic" })
    );
    const newer = repository.create(
      createCandidateInput({ content: "newer", semantic_fingerprint: "shared-semantic" })
    );

    const found = repository.findBySemanticFingerprint("shared-semantic");

    assert.equal(found?.id, newer.id);
    assert.equal(found?.content, "newer");
  } finally {
    db.close();
  }
});

test("findBySemanticFingerprint returns undefined for unknown fingerprint", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);

    assert.equal(repository.findBySemanticFingerprint("no-such-fingerprint"), undefined);
  } finally {
    db.close();
  }
});

test("list filters by semantic_fingerprint", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    const a = repository.create(
      createCandidateInput({ content: "a", semantic_fingerprint: "fp-a" })
    );
    const b = repository.create(
      createCandidateInput({ content: "b", semantic_fingerprint: "fp-b" })
    );
    const c = repository.create(
      createCandidateInput({ content: "c", semantic_fingerprint: null })
    );

    assert.deepEqual(
      repository.list({ semantic_fingerprint: "fp-a" }).map((r) => r.id),
      [a.id]
    );
    assert.deepEqual(
      repository.list({ semantic_fingerprint: "fp-b" }).map((r) => r.id),
      [b.id]
    );
    assert.deepEqual(
      repository.list({ semantic_fingerprint: null }).map((r) => r.id),
      [c.id]
    );
  } finally {
    db.close();
  }
});

test("migration adds semantic_fingerprint to pre-existing partial schema", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    db.exec(`
      CREATE TABLE candidate_memories (
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
      `INSERT INTO candidate_memories
        (id, content, type, project, tags, metadata, extraction_source, extraction_confidence, created_at, updated_at)
        VALUES ('legacy-2', 'old candidate', 'observation', 'vega-memory', '[]', '{}', 'manual', 0.5, 1, 1)`
    );

    const repository = createCandidateRepository(db);
    const legacy = repository.findById("legacy-2");

    assert.equal(legacy?.semantic_fingerprint, null);

    const fresh = repository.create(
      createCandidateInput({ content: "fresh", semantic_fingerprint: "fresh-fp" })
    );

    assert.equal(fresh.semantic_fingerprint, "fresh-fp");
    assert.equal(repository.findBySemanticFingerprint("fresh-fp")?.id, fresh.id);
  } finally {
    db.close();
  }
});
