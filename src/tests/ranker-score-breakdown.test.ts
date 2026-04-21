import assert from "node:assert/strict";
import test from "node:test";

import { rank } from "../retrieval/ranker.js";
import type { SourceRecord } from "../retrieval/sources/types.js";

const request = {
  intent: "lookup" as const,
  mode: "L1" as const,
  query: "ranker",
  surface: "codex" as const,
  session_id: "session-ranker-breakdown",
  project: "vega-memory",
  cwd: "/Users/johnmacmini/workspace/vega-memory"
};

function createRecord(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "record-1",
    source_kind: "wiki",
    content: "Line one\nLine two",
    provenance: {
      origin: "test:record-1",
      retrieved_at: "2026-04-21T00:00:00.000Z"
    },
    raw_score: 0.5,
    created_at: "2026-04-21T00:00:00.000Z",
    ...overrides
  };
}

test("score_breakdown only exposes base, source_prior, and recency", () => {
  const [ranked] = rank([createRecord({ id: "wiki-1" })], request);

  assert.deepEqual(Object.keys(ranked?.score_breakdown ?? {}).sort(), ["base", "recency", "source_prior"]);
  assert.equal("safety_penalty" in (ranked?.score_breakdown ?? {}), false);
  assert.equal("access_frequency" in (ranked?.score_breakdown ?? {}), false);
});

test("newer records rank above older records when other signals are equal", () => {
  const ranked = rank(
    [
      createRecord({
        id: "older",
        source_kind: "wiki",
        raw_score: 0.5,
        created_at: "2026-04-01T00:00:00.000Z"
      }),
      createRecord({
        id: "newer",
        source_kind: "wiki",
        raw_score: 0.5,
        created_at: "2026-04-20T00:00:00.000Z"
      })
    ],
    request
  );

  assert.deepEqual(
    ranked.map((record) => record.id),
    ["newer", "older"]
  );
});

test("higher source_prior still ranks above lower source_prior when recency matches", () => {
  const ranked = rank(
    [
      createRecord({
        id: "archive-1",
        source_kind: "archive",
        raw_score: 0.5,
        created_at: "2026-04-20T00:00:00.000Z"
      }),
      createRecord({
        id: "memory-1",
        source_kind: "vega_memory",
        raw_score: 0.5,
        created_at: "2026-04-20T00:00:00.000Z"
      })
    ],
    request
  );

  assert.deepEqual(
    ranked.map((record) => record.id),
    ["memory-1", "archive-1"]
  );
});
