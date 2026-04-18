import assert from "node:assert/strict";
import test from "node:test";

import {
  createCircuitBreakerStatusMcpTool,
  createCircuitBreakerResetMcpTool
} from "../retrieval/circuit-breaker-mcp-tools.js";
import { createCircuitBreaker } from "../retrieval/circuit-breaker.js";

test("circuit_breaker_status lists all tracked surfaces", async () => {
  const breaker = createCircuitBreaker();
  breaker.recordCheckpoint("claude");
  breaker.recordCheckpoint("codex");
  const tool = createCircuitBreakerStatusMcpTool(breaker);

  const result = await tool.invoke({});

  assert.ok("statuses" in result);
  assert.deepEqual(
    result.statuses.map((status) => status.surface),
    ["claude", "codex"]
  );
});

test("circuit_breaker_status returns one surface when requested", async () => {
  const breaker = createCircuitBreaker();
  breaker.recordCheckpoint("codex");
  const tool = createCircuitBreakerStatusMcpTool(breaker);

  const result = await tool.invoke({
    surface: "codex"
  });

  assert.ok("status" in result);
  assert.equal(result.status.surface, "codex");
});

test("circuit_breaker tools degrade cleanly when unavailable", async () => {
  const statusTool = createCircuitBreakerStatusMcpTool(undefined);
  const resetTool = createCircuitBreakerResetMcpTool(undefined);

  assert.deepEqual(await statusTool.invoke({}), {
    degraded: "circuit_breaker_unavailable"
  });
  assert.deepEqual(
    await resetTool.invoke({
      surface: "codex",
      actor: "tester"
    }),
    {
      degraded: "circuit_breaker_unavailable"
    }
  );
});

test("circuit_breaker_reset degrades cleanly when unavailable", async () => {
  const tool = createCircuitBreakerResetMcpTool(undefined);

  assert.deepEqual(
    await tool.invoke({
      surface: "codex",
      actor: "tester"
    }),
    {
      degraded: "circuit_breaker_unavailable"
    }
  );
});

test("circuit_breaker_reset clears status and returns the new snapshot", async () => {
  const breaker = createCircuitBreaker();
  breaker.recordCheckpoint("codex");
  const tool = createCircuitBreakerResetMcpTool(breaker);

  const result = await tool.invoke({
    surface: "codex",
    actor: "tester"
  });

  assert.deepEqual(result, {
    reset: true,
    surface: "codex",
    status: breaker.getStatus("codex")
  });
});

test("circuit_breaker_reset rejects missing actor", async () => {
  const breaker = createCircuitBreaker();
  const tool = createCircuitBreakerResetMcpTool(breaker);

  await assert.rejects(
    () =>
      tool.invoke({
        surface: "codex"
      }),
    (error: unknown) => error instanceof Error && error.name === "ZodError"
  );
});
