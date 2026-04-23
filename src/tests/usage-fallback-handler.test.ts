import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  createUsageConsumptionCheckpointStore,
  type UsageConsumptionCheckpointStore
} from "../usage/usage-consumption-checkpoint-store.js";
import {
  createUsageFallbackHttpHandler,
  createUsageFallbackMcpTool
} from "../usage/usage-fallback-handler.js";
import {
  LOCAL_WORKSPACE_SOURCES,
  EXTERNAL_SOURCES,
  LOCAL_STOP_CONDITIONS,
  EXTERNAL_STOP_CONDITIONS
} from "../core/contracts/usage-fallback.js";

const createMockStore = (overrides: {
  decisionState?: "sufficient" | "needs_followup" | "needs_external";
  checkpointExists?: boolean;
} = {}): UsageConsumptionCheckpointStore => {
  const records = new Map<string, ReturnType<UsageConsumptionCheckpointStore["get"]>>();

  if (overrides.checkpointExists !== false) {
    records.set("checkpoint-1", {
      bundle_id: "bundle-1",
      checkpoint_id: "checkpoint-1",
      decision_state: overrides.decisionState ?? "needs_external",
      used_items: ["wiki:wiki-1"],
      working_summary: "Test summary",
      submitted_at: Date.now(),
      ttl_expires_at: Date.now() + 3600000
    });
  }

  return {
    put: () => {},
    get: (id: string) => records.get(id),
    evictExpired: () => 0,
    size: () => records.size
  };
};

const createMockResponse = () => ({
  statusCode: 200,
  body: undefined as unknown,
  status(code: number) {
    this.statusCode = code;
    return this;
  },
  json(payload: unknown) {
    this.body = payload;
    return this;
  }
});

test("usage fallback MCP tool returns local_workspace plan when checkpoint has needs_external and local_exhausted is false", async () => {
  const store = createMockStore({ decisionState: "needs_external" });
  const tool = createUsageFallbackMcpTool(store);

  const result = await tool.invoke({
    checkpoint_id: "checkpoint-1",
    local_exhausted: false
  });

  assert.equal(result.checkpoint_id, "checkpoint-1");
  assert.equal(result.ladder_active, true);
  assert.equal(result.current_target, "local_workspace");
  assert.deepEqual(result.allowed_sources, [...LOCAL_WORKSPACE_SOURCES]);
  assert.deepEqual(result.stop_conditions, [...LOCAL_STOP_CONDITIONS]);
  assert.equal(result.user_decision_required, false);
  assert.equal(result.degraded, undefined);
});

test("usage fallback MCP tool keeps hosts on local workspace when external evidence is missing", async () => {
  const store = createMockStore({ decisionState: "needs_external" });
  const tool = createUsageFallbackMcpTool(store);

  const result = await tool.invoke({
    checkpoint_id: "checkpoint-1",
    local_exhausted: true
  });

  assert.equal(result.checkpoint_id, "checkpoint-1");
  assert.equal(result.ladder_active, true);
  assert.equal(result.current_target, "local_workspace");
  assert.deepEqual(result.allowed_sources, [...LOCAL_WORKSPACE_SOURCES]);
  assert.deepEqual(result.stop_conditions, [...LOCAL_STOP_CONDITIONS]);
  assert.equal(result.user_decision_required, false);
  assert.equal(result.degraded, "local_evidence_required");
});

test("usage fallback MCP tool returns external plan after audited local gap evidence", async () => {
  const store = createMockStore({ decisionState: "needs_external" });
  const tool = createUsageFallbackMcpTool(store);

  const result = await tool.invoke({
    checkpoint_id: "checkpoint-1",
    local_exhausted: true,
    local_outcome: {
      checked_sources: ["repo_code", "test_output"],
      stop_condition: "gap_confirmed_external",
      summary: "Repo and test output do not contain the missing API contract."
    }
  });

  assert.equal(result.checkpoint_id, "checkpoint-1");
  assert.equal(result.ladder_active, true);
  assert.equal(result.current_target, "external");
  assert.deepEqual(result.allowed_sources, [...EXTERNAL_SOURCES]);
  assert.deepEqual(result.stop_conditions, [...EXTERNAL_STOP_CONDITIONS]);
  assert.equal(result.user_decision_required, true);
  assert.equal(result.degraded, undefined);
});

test("usage fallback MCP tool returns degraded response when checkpoint not found", async () => {
  const store = createMockStore({ checkpointExists: false });
  const tool = createUsageFallbackMcpTool(store);

  const result = await tool.invoke({
    checkpoint_id: "checkpoint-1",
    local_exhausted: false
  });

  assert.equal(result.checkpoint_id, "checkpoint-1");
  assert.equal(result.ladder_active, false);
  assert.equal(result.current_target, "none");
  assert.equal(result.degraded, "checkpoint_not_found");
  assert.equal(result.allowed_sources.length, 0);
});

test("usage fallback MCP tool returns degraded response when decision_state is not needs_external", async () => {
  const store = createMockStore({ decisionState: "sufficient" });
  const tool = createUsageFallbackMcpTool(store);

  const result = await tool.invoke({
    checkpoint_id: "checkpoint-1",
    local_exhausted: false
  });

  assert.equal(result.checkpoint_id, "checkpoint-1");
  assert.equal(result.ladder_active, false);
  assert.equal(result.current_target, "none");
  assert.equal(result.degraded, "decision_state_not_external");
});

test("usage fallback MCP tool returns degraded response when store is unavailable", async () => {
  const tool = createUsageFallbackMcpTool(undefined);

  const result = await tool.invoke({
    checkpoint_id: "checkpoint-1",
    local_exhausted: false
  });

  assert.equal(result.checkpoint_id, "checkpoint-1");
  assert.equal(result.ladder_active, false);
  assert.equal(result.current_target, "none");
  assert.equal(result.degraded, "store_unavailable");
});

test("usage fallback HTTP handler returns 400 for invalid input", async () => {
  const store = createMockStore();
  const handler = createUsageFallbackHttpHandler(store);
  const response = createMockResponse();

  await handler({ body: {} } as never, response as never);

  assert.equal(response.statusCode, 400);
  assert.equal((response.body as { error?: string }).error, "ValidationError");
});

test("usage fallback HTTP handler returns 200 with local_workspace plan for valid request", async () => {
  const store = createMockStore({ decisionState: "needs_external" });
  const handler = createUsageFallbackHttpHandler(store);
  const response = createMockResponse();

  await handler({
    body: {
      checkpoint_id: "checkpoint-1",
      local_exhausted: false
    }
  } as never, response as never);

  assert.equal(response.statusCode, 200);
  const body = response.body as { ladder_active: boolean; current_target: string };
  assert.equal(body.ladder_active, true);
  assert.equal(body.current_target, "local_workspace");
});

test("usage fallback HTTP handler requires audited local outcome before external plan", async () => {
  const store = createMockStore({ decisionState: "needs_external" });
  const handler = createUsageFallbackHttpHandler(store);
  const response = createMockResponse();

  await handler({
    body: {
      checkpoint_id: "checkpoint-1",
      local_exhausted: true
    }
  } as never, response as never);

  assert.equal(response.statusCode, 200);
  const body = response.body as {
    ladder_active: boolean;
    current_target: string;
    user_decision_required: boolean;
    degraded?: string;
  };
  assert.equal(body.ladder_active, true);
  assert.equal(body.current_target, "local_workspace");
  assert.equal(body.user_decision_required, false);
  assert.equal(body.degraded, "local_evidence_required");
});

test("usage fallback with real SQLite store integration", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createUsageConsumptionCheckpointStore(db);
    const tool = createUsageFallbackMcpTool(store);

    store.put({
      bundle_id: "bundle-1",
      checkpoint_id: "checkpoint-test",
      decision_state: "needs_external",
      used_items: ["wiki:wiki-1"],
      working_summary: "Integration test checkpoint"
    });

    const result = await tool.invoke({
      checkpoint_id: "checkpoint-test",
      local_exhausted: false
    });

    assert.equal(result.checkpoint_id, "checkpoint-test");
    assert.equal(result.ladder_active, true);
    assert.equal(result.current_target, "local_workspace");
    assert.equal(result.allowed_sources.length, LOCAL_WORKSPACE_SOURCES.length);
    assert.equal(result.stop_conditions.length, LOCAL_STOP_CONDITIONS.length);
  } finally {
    db.close();
  }
});

test("usage fallback MCP tool name is usage.fallback", () => {
  const store = createMockStore();
  const tool = createUsageFallbackMcpTool(store);

  assert.equal(tool.name, "usage.fallback");
  assert.equal(typeof tool.description, "string");
  assert.equal(typeof tool.inputSchema, "object");
});
