import assert from "node:assert/strict";
import test from "node:test";

import { BUNDLE_SCHEMA } from "../core/contracts/bundle.js";
import { assembleBundle } from "../retrieval/bundler.js";
import type { BudgetedRecord } from "../retrieval/budget.js";
import type { RankedRecord } from "../retrieval/ranker.js";

function createBudgetedRecord(overrides: Partial<BudgetedRecord> = {}): BudgetedRecord {
  const record: RankedRecord = {
    id: "record-1",
    source_kind: "wiki",
    content: "content",
    provenance: {
      origin: "test:record-1",
      retrieved_at: "2026-04-17T00:00:00.000Z"
    },
    raw_score: 0.7,
    final_score: 0.7,
    score_breakdown: {
      base: 0.7,
      source_prior: 0.5,
      recency: 1,
      safety_penalty: 0
    }
  };

  return {
    record,
    ladder_level: "full",
    content_used: record.content,
    estimated_tokens: 2,
    ...overrides
  };
}

test("empty input produces an empty bundle with a digest", () => {
  const assembly = assembleBundle([], 0, 0);

  assert.equal(assembly.bundle.schema_version, "1.0");
  assert.equal(typeof assembly.bundle_digest, "string");
  assert.ok(assembly.bundle_digest.length > 0);
  assert.deepEqual(assembly.bundle.sections, []);
  assert.deepEqual(BUNDLE_SCHEMA.parse(assembly.bundle), assembly.bundle);
});

test("records of the same kind share a section and remain score-sorted", () => {
  const assembly = assembleBundle(
    [
      createBudgetedRecord({
        record: {
          ...createBudgetedRecord().record,
          id: "wiki-low",
          source_kind: "wiki",
          final_score: 0.3
        },
        content_used: "low"
      }),
      createBudgetedRecord({
        record: {
          ...createBudgetedRecord().record,
          id: "wiki-high",
          source_kind: "wiki",
          final_score: 0.9
        },
        content_used: "high"
      })
    ],
    0,
    4
  );

  assert.equal(assembly.bundle.sections.length, 1);
  assert.deepEqual(
    assembly.bundle.sections[0]?.records.map((record) => record.id),
    ["wiki-high", "wiki-low"]
  );
});

test("distinct source kinds become distinct sections", () => {
  const assembly = assembleBundle(
    [
      createBudgetedRecord({ record: { ...createBudgetedRecord().record, id: "a", source_kind: "wiki" } }),
      createBudgetedRecord({
        record: { ...createBudgetedRecord().record, id: "b", source_kind: "archive" }
      }),
      createBudgetedRecord({
        record: { ...createBudgetedRecord().record, id: "c", source_kind: "vega_memory" }
      })
    ],
    1,
    6
  );

  assert.deepEqual(
    assembly.bundle.sections.map((section) => section.source_kind),
    ["archive", "vega_memory", "wiki"]
  );
});

test("identical inputs yield identical bundle digests", () => {
  const input = [
    createBudgetedRecord({ record: { ...createBudgetedRecord().record, id: "stable-1" } }),
    createBudgetedRecord({
      record: { ...createBudgetedRecord().record, id: "stable-2", source_kind: "graph" }
    })
  ];
  const first = assembleBundle(input, 0, 4);
  const second = assembleBundle(input, 0, 4);

  assert.equal(first.bundle_digest, second.bundle_digest);
});
