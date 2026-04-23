import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  createCheckpointStore,
  createUsageConsumptionCheckpointStore,
  type UsageConsumptionCheckpointStore
} from "../usage/index.js";
import {
  createUsageCheckpointHttpHandler,
  createUsageCheckpointMcpTool
} from "../usage/usage-checkpoint-handler.js";

interface StubResponse {
  statusCode: number;
  body: unknown;
  status(code: number): StubResponse;
  json(payload: unknown): StubResponse;
}

const createResponse = (): StubResponse => ({
  statusCode: 200,
  body: undefined,
  status(code: number) {
    this.statusCode = code;
    return this;
  },
  json(payload: unknown) {
    this.body = payload;
    return this;
  }
});

const createCheckpoint = (
  overrides: Partial<{
    bundle_id: string;
    checkpoint_id: string;
    decision_state: "sufficient" | "needs_followup" | "needs_external";
    used_items: string[];
    working_summary: string;
    bundle_digest: string;
    bundle_summary: string;
  }> = {}
) => ({
  bundle_id: "bundle-1",
  checkpoint_id: "checkpoint-1",
  decision_state: "sufficient" as const,
  used_items: ["wiki:wiki-1", "vega_memory:mem-1"],
  working_summary: "Host consumed bundle and identified next steps for implementation.",
  ...overrides
});

const seedRetrievalCheckpoint = (
  store: ReturnType<typeof createCheckpointStore>,
  overrides: Partial<{
    checkpoint_id: string;
    bundle_digest: string;
    record_ids: string[];
  }> = {}
): void => {
  store.put({
    checkpoint_id: overrides.checkpoint_id ?? "checkpoint-1",
    bundle_digest: overrides.bundle_digest ?? "bundle-1",
    intent: "lookup",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    query_hash: "query-1",
    mode: "L1",
    profile_used: "lookup",
    ranker_version: "v1.0",
    record_ids: overrides.record_ids ?? ["wiki:wiki-1", "vega_memory:mem-1"]
  });
};

const createThrowingStore = (): UsageConsumptionCheckpointStore => ({
  put() {
    throw new Error("db write failed");
  },
  get() {
    return undefined;
  },
  evictExpired() {
    return 0;
  },
  size() {
    return 0;
  }
});

test("HTTP handler returns accepted true for a valid payload", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler({ body: createCheckpoint() } as never, response as never);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      accepted: true,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler returns 400 for an invalid payload", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: {
          bundle_id: "bundle-1",
          checkpoint_id: "checkpoint-1"
        }
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error?: string }).error, "ValidationError");
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to validation_error when used_items is empty", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({ used_items: [] })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.body, {
      accepted: false,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "validation_error",
      retry_hint: "used_items must not be empty when bundle is non-empty"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to validation_error when working_summary is empty", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({ working_summary: "" })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.body, {
      accepted: false,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "validation_error",
      retry_hint: "working_summary must not be empty"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to validation_error when working_summary is whitespace only", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({ working_summary: "   " })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.body, {
      accepted: false,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "validation_error",
      retry_hint: "working_summary must not be empty"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to validation_error when working_summary is whitespace only", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({ working_summary: "   " })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.body, {
      accepted: false,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "validation_error",
      retry_hint: "working_summary must not be empty"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to validation_error when used_items contains invalid refs", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({ used_items: ["not-a-valid-ref"] })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.body, {
      accepted: false,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "validation_error",
      retry_hint: "used_items must contain valid bundle record references"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler rejects fake colon refs that were not in the retrieval bundle", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const consumptionStore = createUsageConsumptionCheckpointStore(db);
    const retrievalStore = createCheckpointStore(db);
    seedRetrievalCheckpoint(retrievalStore);
    const handler = createUsageCheckpointHttpHandler(consumptionStore, undefined, retrievalStore);
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({ used_items: ["wiki:wiki-1", "wiki:fake"] })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.body, {
      accepted: false,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "validation_error",
      retry_hint: "used_items must reference records from the checkpoint retrieval bundle"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler rejects copied bundle summaries", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({
          working_summary: "Bundle says install tests before implementation.",
          bundle_summary: "Bundle says install tests before implementation."
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.body, {
      accepted: false,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "validation_error",
      retry_hint: "working_summary must describe consumption, not copy the bundle summary"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler rejects checkpoints whose bundle digest does not match the retrieval checkpoint", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const consumptionStore = createUsageConsumptionCheckpointStore(db);
    const retrievalStore = createCheckpointStore(db);
    seedRetrievalCheckpoint(retrievalStore, { bundle_digest: "expected-digest" });
    const handler = createUsageCheckpointHttpHandler(consumptionStore, undefined, retrievalStore);
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({ bundle_id: "wrong-digest" })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.body, {
      accepted: false,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "validation_error",
      retry_hint: "bundle_digest must match the checkpoint retrieval bundle"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to low_confidence_checkpoint for generic summary", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({
          working_summary: "This is a summary of the bundle contents."
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      accepted: true,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "low_confidence_checkpoint"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to low_confidence_checkpoint for very short summary", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({
          working_summary: "Short."
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      accepted: true,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "low_confidence_checkpoint"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to low_confidence_checkpoint for few used_items", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({
          used_items: ["wiki:wiki-1"]
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      accepted: true,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "low_confidence_checkpoint"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler degrades to usage_checkpoint_unavailable when no store is configured", async () => {
  const handler = createUsageCheckpointHttpHandler(undefined);
  const response = createResponse();

  await handler({ body: createCheckpoint() } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    accepted: true,
    checkpoint_id: "checkpoint-1",
    decision_state: "sufficient",
    degraded: "usage_checkpoint_unavailable"
  });
});

test("HTTP handler degrades to persist_failed when store persistence throws", async () => {
  const handler = createUsageCheckpointHttpHandler(createThrowingStore());
  const response = createResponse();

  await handler({ body: createCheckpoint() } as never, response as never);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      accepted: true,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "persist_failed"
    });
  });

  test("MCP tool invoke returns accepted true for a valid payload", async () => {
    const db = new SQLiteAdapter(":memory:");

    try {
      const tool = createUsageCheckpointMcpTool(createUsageConsumptionCheckpointStore(db));

      const result = await tool.invoke(createCheckpoint());

      assert.deepEqual(result, {
        accepted: true,
        checkpoint_id: "checkpoint-1",
        decision_state: "sufficient"
      });
    } finally {
      db.close();
    }
  });

test("MCP tool invoke degrades to validation_error for empty used_items", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const tool = createUsageCheckpointMcpTool(createUsageConsumptionCheckpointStore(db));

    const result = await tool.invoke(createCheckpoint({ used_items: [] }));

    assert.deepEqual(result, {
      accepted: false,
      checkpoint_id: "checkpoint-1",
      decision_state: "sufficient",
      degraded: "validation_error",
      retry_hint: "used_items must not be empty when bundle is non-empty"
    });
  } finally {
    db.close();
  }
});

test("MCP tool invoke degrades to usage_checkpoint_unavailable when no store is configured", async () => {
  const tool = createUsageCheckpointMcpTool(undefined);

  const result = await tool.invoke(createCheckpoint());

  assert.deepEqual(result, {
    accepted: true,
    checkpoint_id: "checkpoint-1",
    decision_state: "sufficient",
    degraded: "usage_checkpoint_unavailable"
  });
});

test("MCP tool invoke degrades to persist_failed when store persistence throws", async () => {
  const tool = createUsageCheckpointMcpTool(createThrowingStore());

  const result = await tool.invoke(createCheckpoint());

  assert.deepEqual(result, {
    accepted: true,
    checkpoint_id: "checkpoint-1",
    decision_state: "sufficient",
    degraded: "persist_failed"
  });
});

test("MCP tool name is usage.checkpoint", async () => {
  const tool = createUsageCheckpointMcpTool(undefined);

  assert.equal(tool.name, "usage.checkpoint");
});

test("Store persists and retrieves the checkpoint after HTTP handler accepts", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createUsageConsumptionCheckpointStore(db);
    const handler = createUsageCheckpointHttpHandler(store);
    const response = createResponse();

    await handler({ body: createCheckpoint() } as never, response as never);

    const record = store.get("checkpoint-1");

    assert.equal(record?.bundle_id, "bundle-1");
    assert.equal(record?.decision_state, "sufficient");
    assert.deepEqual(record?.used_items, ["wiki:wiki-1", "vega_memory:mem-1"]);
    assert.equal(record?.working_summary, "Host consumed bundle and identified next steps for implementation.");
  } finally {
    db.close();
  }
});

test("Handler accepts all three decision_state values without validation error", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const store = createUsageConsumptionCheckpointStore(db);
    const handler = createUsageCheckpointHttpHandler(store);

    for (const decision_state of ["sufficient", "needs_followup", "needs_external"] as const) {
      const response = createResponse();
      await handler(
        {
          body: createCheckpoint({
            checkpoint_id: `checkpoint-${decision_state}`,
            decision_state
          })
        } as never,
        response as never
      );

      assert.equal(response.statusCode, 200);
      const body = response.body as {
        accepted: boolean;
        checkpoint_id: string;
        decision_state: string;
        follow_up_hint?: object;
        handoff_hint?: object;
      };
      assert.equal(body.accepted, true);
      assert.equal(body.checkpoint_id, `checkpoint-${decision_state}`);
      assert.equal(body.decision_state, decision_state);

      if (decision_state === "needs_followup") {
        assert.ok(body.follow_up_hint);
      } else if (decision_state === "needs_external") {
        assert.ok(body.handoff_hint);
      }
    }
  } finally {
    db.close();
  }
});

test("HTTP handler returns follow_up_hint for needs_followup decision_state", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({
          checkpoint_id: "checkpoint-followup",
          decision_state: "needs_followup"
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    const body = response.body as {
      accepted: boolean;
      checkpoint_id: string;
      decision_state: string;
      follow_up_hint?: { suggested_intent?: string; reason?: string };
    };
    assert.equal(body.accepted, true);
    assert.equal(body.checkpoint_id, "checkpoint-followup");
    assert.equal(body.decision_state, "needs_followup");
    assert.ok(body.follow_up_hint);
    assert.equal(body.follow_up_hint?.suggested_intent, "followup");
    assert.ok(body.follow_up_hint?.reason);
  } finally {
    db.close();
  }
});

test("HTTP handler returns handoff_hint for needs_external decision_state", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageCheckpointHttpHandler(createUsageConsumptionCheckpointStore(db));
    const response = createResponse();

    await handler(
      {
        body: createCheckpoint({
          checkpoint_id: "checkpoint-external",
          decision_state: "needs_external"
        })
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    const body = response.body as {
      accepted: boolean;
      checkpoint_id: string;
      decision_state: string;
      handoff_hint?: { target?: string; reason?: string };
    };
    assert.equal(body.accepted, true);
    assert.equal(body.checkpoint_id, "checkpoint-external");
    assert.equal(body.decision_state, "needs_external");
    assert.ok(body.handoff_hint);
    assert.equal(body.handoff_hint?.target, "local_workspace");
    assert.ok(body.handoff_hint?.reason);
  } finally {
    db.close();
  }
});

test("MCP tool returns follow_up_hint for needs_followup decision_state", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const tool = createUsageCheckpointMcpTool(createUsageConsumptionCheckpointStore(db));

    const result = await tool.invoke(
      createCheckpoint({
        checkpoint_id: "checkpoint-followup",
        decision_state: "needs_followup"
      })
    );

    assert.equal(result.accepted, true);
    assert.equal(result.checkpoint_id, "checkpoint-followup");
    assert.equal(result.decision_state, "needs_followup");
    assert.ok(result.follow_up_hint);
    assert.equal(result.follow_up_hint?.suggested_intent, "followup");
    assert.ok(result.follow_up_hint?.reason);
  } finally {
    db.close();
  }
});

test("MCP tool returns handoff_hint for needs_external decision_state", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const tool = createUsageCheckpointMcpTool(createUsageConsumptionCheckpointStore(db));

    const result = await tool.invoke(
      createCheckpoint({
        checkpoint_id: "checkpoint-external",
        decision_state: "needs_external"
      })
    );

    assert.equal(result.accepted, true);
    assert.equal(result.checkpoint_id, "checkpoint-external");
    assert.equal(result.decision_state, "needs_external");
    assert.ok(result.handoff_hint);
    assert.equal(result.handoff_hint?.target, "local_workspace");
    assert.ok(result.handoff_hint?.reason);
  } finally {
    db.close();
  }
});
