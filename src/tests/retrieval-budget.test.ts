import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBudget,
  estimateTokens,
  ladderApply,
  type BudgetConfig
} from "../retrieval/budget.js";
import type { RankedRecord } from "../retrieval/ranker.js";

function createRankedRecord(overrides: Partial<RankedRecord> = {}): RankedRecord {
  return {
    id: "record-1",
    source_kind: "wiki",
    content: "Headline\nBody content that is long enough to be summarized for budget testing.".repeat(6),
    provenance: {
      origin: "test:record-1",
      retrieved_at: "2026-04-17T00:00:00.000Z"
    },
    raw_score: 0.7,
    final_score: 0.8,
    score_breakdown: {
      base: 0.7,
      source_prior: 0.5
    },
    ...overrides
  };
}

const tinyBudget: BudgetConfig = {
  max_tokens_by_mode: {
    L0: 5,
    L1: 5,
    L2: 5,
    L3: 5
  },
  host_memory_file_reserved: 0
};

test("estimateTokens returns zero for empty strings and positive values otherwise", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("abcd") > 0);
});

test("ladderApply emits the expected content shape for each ladder level", () => {
  const record = createRankedRecord({
    id: "record-2",
    source_kind: "graph",
    content: `Title line\n${"x".repeat(240)}`
  });

  assert.equal(ladderApply(record, "full").content_used, record.content);
  assert.equal(ladderApply(record, "summary").content_used, `${record.content.slice(0, 200)}…`);
  assert.equal(ladderApply(record, "headline").content_used, "Title line");
  assert.equal(ladderApply(record, "reference").content_used, "[graph:record-2]");
});

test("sufficient budget keeps every record at full fidelity", () => {
  const recordA = createRankedRecord({ id: "a", final_score: 0.9 });
  const recordB = createRankedRecord({ id: "b", final_score: 0.8, source_kind: "vega_memory" });
  const result = applyBudget([recordA, recordB], "L1");

  assert.deepEqual(
    result.budgeted.map((entry) => entry.ladder_level),
    ["full", "full"]
  );
  assert.ok(result.total_tokens >= estimateTokens(recordA.content) + estimateTokens(recordB.content));
});

test("tiny budgets downgrade records to references when that is the only fit", () => {
  const result = applyBudget(
    [
      createRankedRecord({ id: "a", final_score: 0.9, content: "x".repeat(400) }),
      createRankedRecord({ id: "b", final_score: 0.8, source_kind: "archive", content: "y".repeat(400) })
    ],
    "L0",
    tinyBudget
  );

  assert.deepEqual(
    result.budgeted.map((entry) => entry.ladder_level),
    ["reference", "reference"]
  );
  assert.equal(result.truncated_count, 2);
});

test("manual host_memory_file reserve config still pulls back a record when explicitly enabled", () => {
  const crowded = createRankedRecord({
    id: "crowded",
    source_kind: "vega_memory",
    final_score: 0.99,
    content: "A".repeat(120)
  });
  const host = createRankedRecord({
    id: "host-1",
    source_kind: "host_memory_file",
    final_score: 0.1,
    content: "B".repeat(200)
  });
  const result = applyBudget(
    [crowded, host],
    "L0",
    {
      max_tokens_by_mode: {
        L0: estimateTokens(crowded.content) + estimateTokens("[host_memory_file:host-1]"),
        L1: 2000,
        L2: 6000,
        L3: 12000
      },
      host_memory_file_reserved: estimateTokens("[host_memory_file:host-1]")
    }
  );

  assert.equal(result.budgeted.some((entry) => entry.record.id === "host-1"), true);
  assert.equal(
    result.budgeted.find((entry) => entry.record.id === "host-1")?.ladder_level,
    "reference"
  );
});
