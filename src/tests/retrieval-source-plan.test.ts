import assert from "node:assert/strict";
import test from "node:test";

import type { IntentRequest } from "../core/contracts/intent.js";
import { createSourcePlan } from "../retrieval/source-plan.js";
import { getProfile } from "../retrieval/profiles.js";

function createRequest(overrides: Partial<IntentRequest> = {}): IntentRequest {
  return {
    intent: "lookup",
    mode: "L1",
    query: "vega retrieval",
    surface: "codex",
    session_id: "session-source-plan",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    ...overrides
  };
}

test("query_focus history biases lookup toward hot/history sources first", () => {
  const plan = createSourcePlan(
    getProfile("lookup"),
    createRequest({
      query_focus: "history"
    })
  );

  assert.deepEqual(plan.primary_sources, ["vega_memory", "host_memory_file"]);
  assert.deepEqual(plan.fallback_sources, ["wiki", "fact_claim"]);
});

test("query_focus docs biases lookup toward wiki and fact claims first", () => {
  const plan = createSourcePlan(
    getProfile("lookup"),
    createRequest({
      query_focus: "docs"
    })
  );

  assert.deepEqual(plan.primary_sources, ["wiki", "fact_claim"]);
  assert.deepEqual(plan.fallback_sources, ["vega_memory", "host_memory_file"]);
});

test("host_hint can weakly pull a preferred source into the primary set", () => {
  const plan = createSourcePlan(
    getProfile("lookup"),
    createRequest({
      host_hint: {
        preferred_sources: ["graph", "wiki"]
      }
    })
  );

  assert.deepEqual(plan.primary_sources, ["graph", "wiki", "vega_memory", "fact_claim", "host_memory_file"]);
  assert.deepEqual(plan.fallback_sources, []);
});

test("query_focus evidence biases lookup toward provenance-bearing sources", () => {
  const plan = createSourcePlan(
    getProfile("lookup"),
    createRequest({
      query_focus: "evidence"
    })
  );

  assert.deepEqual(plan.primary_sources, ["fact_claim"]);
  assert.deepEqual(plan.fallback_sources, ["vega_memory", "wiki", "host_memory_file"]);
});
