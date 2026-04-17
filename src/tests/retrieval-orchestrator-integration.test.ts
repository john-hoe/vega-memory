import assert from "node:assert/strict";
import test from "node:test";

import { SOURCE_KINDS } from "../core/contracts/enums.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import { createDefaultRegistry } from "../retrieval/orchestrator-config.js";

test("createDefaultRegistry registers every source kind and falls back to disabled stubs", () => {
  const registry = createDefaultRegistry({});

  assert.deepEqual(
    registry
      .list()
      .map((adapter) => adapter.kind)
      .sort(),
    [...SOURCE_KINDS].sort()
  );

  assert.equal(registry.get("candidate").enabled, false);
  assert.equal(registry.get("host_memory_file").enabled, false);
  assert.equal(registry.get("vega_memory").enabled, false);
  assert.equal(registry.get("wiki").enabled, false);
  assert.equal(registry.get("fact_claim").enabled, false);
  assert.equal(registry.get("graph").enabled, false);
  assert.equal(registry.get("archive").enabled, false);
});

test("orchestrator resolves safely against the default fallback registry", () => {
  const registry = createDefaultRegistry({});
  const orchestrator = new RetrievalOrchestrator({ registry });

  const response = orchestrator.resolve({
    intent: "bootstrap",
    mode: "L1",
    query: "vega",
    surface: "codex",
    session_id: "session-default-registry",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory"
  });

  assert.equal(response.profile_used, "bootstrap");
  assert.deepEqual(response.bundle.sections, []);
  assert.equal(response.sufficiency_hint, "may_need_followup");
});
