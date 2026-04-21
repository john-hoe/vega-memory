import assert from "node:assert/strict";
import test from "node:test";

import { recordKey } from "../core/contracts/checkpoint-record.js";
import { rank } from "../retrieval/ranker.js";
import type { SourceRecord } from "../retrieval/sources/types.js";

const request = {
  intent: "lookup" as const,
  mode: "L1" as const,
  query: "ranker",
  surface: "codex" as const,
  session_id: "session-ranker",
  project: "vega-memory",
  cwd: "/Users/johnmacmini/workspace/vega-memory"
};

function createRecord(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "record-1",
    source_kind: "wiki",
    content: "Line one\nLine two",
    created_at: "2026-04-17T00:00:00.000Z",
    provenance: {
      origin: "test:record-1",
      retrieved_at: "2026-04-17T00:00:00.000Z"
    },
    raw_score: 0.5,
    ...overrides
  };
}

test("empty input returns an empty array", () => {
  assert.deepEqual(rank([], request), []);
});

test("higher source prior wins when raw scores match", () => {
  const ranked = rank(
    [
      createRecord({ id: "wiki-1", source_kind: "wiki", raw_score: 0.6 }),
      createRecord({ id: "vm-1", source_kind: "vega_memory", raw_score: 0.6 })
    ],
    request
  );

  assert.equal(ranked[0]?.id, "vm-1");
  assert.ok((ranked[0]?.final_score ?? 0) > (ranked[1]?.final_score ?? 0));
});

test("results are returned in descending final_score order", () => {
  const ranked = rank(
    [
      createRecord({ id: "archive-1", source_kind: "archive", raw_score: 0.2 }),
      createRecord({ id: "vm-1", source_kind: "vega_memory", raw_score: 0.9 }),
      createRecord({ id: "wiki-1", source_kind: "wiki", raw_score: 0.4 })
    ],
    request
  );

  assert.deepEqual(
    ranked.map((record) => record.id),
    ["vm-1", "wiki-1", "archive-1"]
  );
});

test("score breakdown only exposes signals the ranker actually computes", () => {
  const [ranked] = rank([createRecord({ id: "fact-1", source_kind: "fact_claim" })], request);

  assert.deepEqual(Object.keys(ranked?.score_breakdown ?? {}).sort(), ["base", "recency", "source_prior"]);
  assert.equal("recency" in (ranked?.score_breakdown ?? {}), true);
  assert.equal("safety_penalty" in (ranked?.score_breakdown ?? {}), false);
});

test("demote_ids applies the 0.3x followup penalty when the composite key matches", () => {
  const record = createRecord({ id: "wiki-1", source_kind: "wiki", raw_score: 0.8 });
  const [baseline] = rank([record], request);
  const [demoted] = rank([record], request, undefined, new Set([recordKey(record.source_kind, record.id)]));

  assert.equal(demoted?.final_score, (baseline?.final_score ?? 0) * 0.3);
});

test("bare ids do not trigger demotion without the source-kind prefix", () => {
  const record = createRecord({ id: "wiki-1", source_kind: "wiki", raw_score: 0.8 });
  const [baseline] = rank([record], request);
  const [demoted] = rank([record], request, undefined, new Set([record.id]));

  assert.equal(demoted?.final_score, baseline?.final_score);
});
