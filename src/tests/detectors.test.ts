import assert from "node:assert/strict";
import test from "node:test";

import { DuplicateDetector } from "../core/detectors/duplicate-detector.js";
import { ExpiredFactDetector } from "../core/detectors/expired-fact-detector.js";
import { GlobalPromotionDetector } from "../core/detectors/global-promotion-detector.js";
import type { FactClaim, Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";

const now = "2026-04-10T00:00:00.000Z";

const createEmbeddingBuffer = (values: number[]): Buffer =>
  Buffer.from(new Float32Array(values).buffer);

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  tenant_id: null,
  type: "insight",
  project: "vega",
  title: "Memory title",
  content: "Memory content",
  summary: null,
  embedding: null,
  importance: 0.8,
  source: "explicit",
  tags: ["detector"],
  created_at: now,
  updated_at: now,
  accessed_at: now,
  status: "active",
  verified: "unverified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const createFactClaim = (overrides: Partial<FactClaim> = {}): FactClaim => ({
  id: "fact-1",
  tenant_id: null,
  project: "vega",
  source_memory_id: "memory-source",
  evidence_archive_id: null,
  canonical_key: "vega-memory|database|sqlite",
  subject: "vega-memory",
  predicate: "database",
  claim_value: "sqlite",
  claim_text: "Vega Memory uses SQLite.",
  source: "hot_memory",
  status: "active",
  confidence: 0.8,
  valid_from: "2026-04-01T00:00:00.000Z",
  valid_to: null,
  temporal_precision: "day",
  invalidation_reason: null,
  created_at: now,
  updated_at: now,
  ...overrides
});

test("DuplicateDetector detects duplicate memories with similar embeddings", () => {
  const repository = new Repository(":memory:");
  const detector = new DuplicateDetector();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "duplicate-a",
        type: "insight",
        title: "Auth cache decision",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.4]),
        updated_at: "2026-04-09T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "duplicate-b",
        type: "insight",
        title: "Auth cache design",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.41]),
        updated_at: "2026-04-10T00:00:00.000Z"
      })
    );

    const candidates = detector.detect({
      project: "vega",
      repository
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.kind, "duplicate_merge");
    assert.deepEqual(candidates[0]?.memory_ids, ["duplicate-a", "duplicate-b"]);
  } finally {
    repository.close();
  }
});

test("DuplicateDetector ignores memories of different types", () => {
  const repository = new Repository(":memory:");
  const detector = new DuplicateDetector();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-a",
        type: "insight",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.4])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-b",
        type: "decision",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.41])
      })
    );

    const candidates = detector.detect({
      project: "vega",
      repository
    });

    assert.equal(candidates.length, 0);
  } finally {
    repository.close();
  }
});

test("DuplicateDetector ignores memories without embeddings", () => {
  const repository = new Repository(":memory:");
  const detector = new DuplicateDetector();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-a",
        title: "Auth cache decision"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-b",
        title: "Auth cache design"
      })
    );

    const candidates = detector.detect({
      project: "vega",
      repository
    });

    assert.equal(candidates.length, 0);
  } finally {
    repository.close();
  }
});

test("DuplicateDetector respects tenant isolation", () => {
  const repository = new Repository(":memory:");
  const detector = new DuplicateDetector();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "tenant-a-1",
        tenant_id: "tenant-a",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.4])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "tenant-a-2",
        tenant_id: "tenant-a",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.41])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "tenant-b-1",
        tenant_id: "tenant-b",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.4])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "tenant-b-2",
        tenant_id: "tenant-b",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.41])
      })
    );

    const candidates = detector.detect({
      project: "vega",
      tenantId: "tenant-a",
      repository
    });

    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0]?.memory_ids, ["tenant-a-1", "tenant-a-2"]);
  } finally {
    repository.close();
  }
});

test("ExpiredFactDetector detects temporally expired claims", () => {
  const repository = new Repository(":memory:");
  const detector = new ExpiredFactDetector();

  try {
    repository.createMemory(createStoredMemory({ id: "memory-source" }));
    repository.createFactClaim(
      createFactClaim({
        id: "expired-claim",
        valid_to: "2026-04-01T00:00:00.000Z"
      })
    );

    const candidates = detector.detect({
      project: "vega",
      repository
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.kind, "expired_fact");
    assert.equal(candidates[0]?.action, "mark_expired");
    assert.deepEqual(candidates[0]?.fact_claim_ids, ["expired-claim"]);
  } finally {
    repository.close();
  }
});

test("ExpiredFactDetector detects superseded claims", () => {
  const repository = new Repository(":memory:");
  const detector = new ExpiredFactDetector();

  try {
    repository.createMemory(createStoredMemory({ id: "memory-source" }));
    repository.createMemory(createStoredMemory({ id: "memory-source-2" }));
    repository.createFactClaim(
      createFactClaim({
        id: "older-claim",
        source_memory_id: "memory-source",
        valid_from: "2026-04-01T00:00:00.000Z"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "newer-claim",
        source_memory_id: "memory-source-2",
        valid_from: "2026-04-05T00:00:00.000Z"
      })
    );

    const candidates = detector.detect({
      project: "vega",
      repository
    });

    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0]?.fact_claim_ids, ["older-claim", "newer-claim"]);
    assert.equal(candidates[0]?.risk, "medium");
  } finally {
    repository.close();
  }
});

test("ExpiredFactDetector ignores already-expired claims", () => {
  const repository = new Repository(":memory:");
  const detector = new ExpiredFactDetector();

  try {
    repository.createMemory(createStoredMemory({ id: "memory-source" }));
    repository.createFactClaim(
      createFactClaim({
        id: "expired-claim",
        status: "expired",
        valid_to: "2026-04-01T00:00:00.000Z"
      })
    );

    const candidates = detector.detect({
      project: "vega",
      repository
    });

    assert.equal(candidates.length, 0);
  } finally {
    repository.close();
  }
});

test("GlobalPromotionDetector recommends multi-project memory for promotion", () => {
  const repository = new Repository(":memory:");
  const detector = new GlobalPromotionDetector();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "pitfall-1",
        type: "pitfall",
        title: "SQLite migration pitfall",
        accessed_projects: ["proj-a", "proj-b"]
      })
    );

    const candidates = detector.detect({
      project: "vega",
      repository
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.action, "promote_global");
    assert.deepEqual(candidates[0]?.memory_ids, ["pitfall-1"]);
  } finally {
    repository.close();
  }
});

test("GlobalPromotionDetector ignores task_state memories", () => {
  const repository = new Repository(":memory:");
  const detector = new GlobalPromotionDetector();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "task-1",
        type: "task_state",
        accessed_projects: ["proj-a", "proj-b"]
      })
    );

    const candidates = detector.detect({
      project: "vega",
      repository
    });

    assert.equal(candidates.length, 0);
  } finally {
    repository.close();
  }
});

test("GlobalPromotionDetector ignores already-global memories", () => {
  const repository = new Repository(":memory:");
  const detector = new GlobalPromotionDetector();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "global-1",
        type: "pitfall",
        scope: "global",
        accessed_projects: ["proj-a", "proj-b"]
      })
    );

    const candidates = detector.detect({
      project: "vega",
      repository
    });

    assert.equal(candidates.length, 0);
  } finally {
    repository.close();
  }
});
