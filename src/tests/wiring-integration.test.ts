import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { INTENT_REQUEST_SCHEMA } from "../core/contracts/intent.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { createMCPServer } from "../mcp/server.js";
import type { ContextResolveResponse } from "../retrieval/orchestrator.js";
import { createContextResolveHttpHandler, createContextResolveMcpTool } from "../retrieval/context-resolve-handler.js";
import { Repository } from "../db/repository.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { createIngestEventMcpTool } from "../ingestion/ingest-event-handler.js";
import {
  createCandidateCreateMcpTool,
  createCandidateEvaluateMcpTool,
  createCandidateDemoteMcpTool,
  createCandidateListMcpTool,
  createCandidatePromoteMcpTool,
  createCandidateSweepMcpTool
} from "../promotion/candidate-mcp-tools.js";
import {
  createCircuitBreakerResetMcpTool,
  createCircuitBreakerStatusMcpTool
} from "../retrieval/circuit-breaker-mcp-tools.js";
import { createCircuitBreaker } from "../retrieval/circuit-breaker.js";
import { RAW_INBOX_TABLE, applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { SearchEngine } from "../search/engine.js";
import { createUsageAckHttpHandler, createUsageAckMcpTool } from "../usage/usage-ack-handler.js";
import { createUsageCheckpointHttpHandler, createUsageCheckpointMcpTool } from "../usage/usage-checkpoint-handler.js";
import { createUsageFallbackHttpHandler, createUsageFallbackMcpTool } from "../usage/usage-fallback-handler.js";
import { createAckStore, createUsageConsumptionCheckpointStore } from "../usage/index.js";

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");
const cliModuleUrl = pathToFileURL(cliPath).href;
const childBaseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("VEGA_") && key !== "OLLAMA_BASE_URL" && key !== "OLLAMA_MODEL"
  )
);
const cliBootstrap = `process.argv.splice(1, 0, ${JSON.stringify(cliPath)}); await import(${JSON.stringify(cliModuleUrl)});`;

const runCli = (args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync(process.execPath, ["--input-type=module", "-e", cliBootstrap, "--", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...childBaseEnv,
      ...env
    }
  });

const createApiHarness = async (apiKey?: string): Promise<{
  baseUrl: string;
  cleanup(): Promise<void>;
}> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-wiring-api-"));
  const config: VegaConfig = {
    dbPath: join(tempDir, "memory.db"),
    ollamaBaseUrl: "http://localhost:99999",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    shardingEnabled: false,
    backupRetentionDays: 7,
    apiPort: 0,
    apiKey,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(tempDir, "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    observerEnabled: false,
    dbEncryption: false
  };
  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);
  const compactService = new CompactService(repository, config);
  const server = createAPIServer(
    {
      repository,
      memoryService,
      recallService,
      sessionService,
      compactService
    },
    config
  );
  const port = await server.start(0);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async cleanup(): Promise<void> {
      await server.stop();
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
};

const getRegisteredTools = (
  server: ReturnType<typeof createMCPServer>
): Record<
  string,
  {
    handler: (
      args: Record<string, unknown>,
      extra: object
    ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
  }
> =>
  (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
            extra: object
          ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
        }
      >;
    }
  )._registeredTools;

const createMcpHarness = () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-wiring-mcp-"));
  const config: VegaConfig = {
    dbPath: join(tempDir, "memory.db"),
    ollamaBaseUrl: "http://localhost:99999",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    shardingEnabled: false,
    backupRetentionDays: 7,
    apiPort: 0,
    apiKey: undefined,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(tempDir, "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    observerEnabled: false,
    dbEncryption: false
  };
  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);
  const compactService = new CompactService(repository, config);
  const graphService = {
    query: () => ({ entity: null, relations: [], memories: [] }),
    getNeighbors: () => ({ entity: null, neighbors: [], relations: [], memories: [] }),
    shortestPath: () => ({ from: null, to: null, entities: [], relations: [], memories: [], found: false }),
    graphStats: () => ({
      total_entities: 0,
      total_relations: 0,
      entity_types: {},
      relation_types: {},
      average_confidence: null,
      tracked_code_files: 0,
      tracked_doc_files: 0
    }),
    subgraph: () => ({ seed_entities: [], missing_entities: [], entities: [], relations: [], memories: [] })
  };
  const server = createMCPServer({
    repository,
    graphService,
    memoryService,
    recallService,
    sessionService,
    compactService,
    config
  });

  return {
    server,
    async cleanup(): Promise<void> {
      await server.close();
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
};

test("CLI help output includes the replay command", () => {
  const output = runCli(["--help"], {
    VEGA_DB_PATH: ":memory:",
    OLLAMA_BASE_URL: "http://localhost:99999"
  });

  assert.match(output, /\breplay\b/);
});

test("ingest_event, context.resolve, usage.ack, and candidate MCP factories expose the expected tool names", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const ingestEventTool = createIngestEventMcpTool(db);
    const contextResolveTool = createContextResolveMcpTool({
      resolve() {
        return {
          checkpoint_id: "checkpoint-1",
          bundle_digest: "bundle-1",
          bundle: {
            schema_version: "1.0",
            checkpoint_id: "checkpoint-1",
            bundle_digest: "bundle-1",
            sections: [],
            used_sources: [],
            fallback_used: false,
            confidence: 0,
            warnings: [],
            next_retrieval_hint: "none"
          },
          sufficiency_hint: "likely_sufficient",
          profile_used: "lookup",
          ranker_version: "v1.0",
          used_sources: [],
          fallback_used: false,
          confidence: 0,
          warnings: [],
          next_retrieval_hint: "none"
        } satisfies ContextResolveResponse;
      }
    } as never);
    const usageAckTool = createUsageAckMcpTool(createAckStore(db));
    const usageCheckpointTool = createUsageCheckpointMcpTool(createUsageConsumptionCheckpointStore(db));
    const usageFallbackTool = createUsageFallbackMcpTool(createUsageConsumptionCheckpointStore(db));
    const circuitBreaker = createCircuitBreaker();
    const circuitBreakerStatusTool = createCircuitBreakerStatusMcpTool(circuitBreaker);
    const circuitBreakerResetTool = createCircuitBreakerResetMcpTool(circuitBreaker);
    const candidateCreateTool = createCandidateCreateMcpTool(undefined);
    const candidateListTool = createCandidateListMcpTool(undefined);
    const candidatePromoteTool = createCandidatePromoteMcpTool(undefined);
    const candidateDemoteTool = createCandidateDemoteMcpTool(undefined);
    const candidateEvaluateTool = createCandidateEvaluateMcpTool(undefined);
    const candidateSweepTool = createCandidateSweepMcpTool(undefined);

    assert.equal(ingestEventTool.name, "ingest_event");
    assert.equal(contextResolveTool.name, "context.resolve");
    assert.equal(usageAckTool.name, "usage.ack");
    assert.equal(usageCheckpointTool.name, "usage.checkpoint");
    assert.equal(usageFallbackTool.name, "usage.fallback");
    assert.equal(circuitBreakerStatusTool.name, "circuit_breaker_status");
    assert.equal(circuitBreakerResetTool.name, "circuit_breaker_reset");
    assert.equal(candidateCreateTool.name, "candidate_create");
    assert.equal(candidateListTool.name, "candidate_list");
    assert.equal(candidatePromoteTool.name, "candidate_promote");
    assert.equal(candidateDemoteTool.name, "candidate_demote");
    assert.equal(candidateEvaluateTool.name, "candidate_evaluate");
    assert.equal(candidateSweepTool.name, "candidate_sweep");
  } finally {
    db.close();
  }
});

test("intent request schema requires prev_checkpoint_id only for followup", () => {
  const followupWithoutPrev = INTENT_REQUEST_SCHEMA.safeParse({
    intent: "followup",
    query: "checkpoint followup",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory"
  });
  const followupWithPrev = INTENT_REQUEST_SCHEMA.safeParse({
    intent: "followup",
    query: "checkpoint followup",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    prev_checkpoint_id: "checkpoint-1"
  });

  assert.equal(followupWithoutPrev.success, false);
  assert.equal(followupWithPrev.success, true);

  for (const intent of ["lookup", "bootstrap", "evidence"] as const) {
    const result = INTENT_REQUEST_SCHEMA.safeParse({
      intent,
      query: `${intent} query`,
      surface: "codex",
      session_id: "session-1",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory"
    });

    assert.equal(result.success, true);
  }
});

test("intent request schema allows omitted or empty queries", () => {
  const missingQuery = INTENT_REQUEST_SCHEMA.safeParse({
    intent: "lookup",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory"
  });
  const emptyQuery = INTENT_REQUEST_SCHEMA.safeParse({
    intent: "lookup",
    query: "",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory"
  });
  const validQuery = INTENT_REQUEST_SCHEMA.safeParse({
    intent: "lookup",
    query: "SQLite backup evidence",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory"
  });

  assert.equal(missingQuery.success, true);
  assert.equal(emptyQuery.success, true);
  assert.equal(validQuery.success, true);
});

test("POST /ingest_event, POST /context_resolve, POST /usage_ack, POST /usage_checkpoint, and POST /usage_fallback are mounted on the HTTP API", async () => {
  const harness = await createApiHarness();

  try {
    const ingestResponse = await fetch(`${harness.baseUrl}/ingest_event`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const contextResolveResponse = await fetch(`${harness.baseUrl}/context_resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const usageAckResponse = await fetch(`${harness.baseUrl}/usage_ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const usageCheckpointResponse = await fetch(`${harness.baseUrl}/usage_checkpoint`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const usageFallbackResponse = await fetch(`${harness.baseUrl}/usage_fallback`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    assert.notEqual(ingestResponse.status, 404);
    assert.notEqual(contextResolveResponse.status, 404);
    assert.notEqual(usageAckResponse.status, 404);
    assert.notEqual(usageCheckpointResponse.status, 404);
    assert.notEqual(usageFallbackResponse.status, 404);
  } finally {
    await harness.cleanup();
  }
});

test("POST /ingest_event returns 401 without authorization when apiKey is configured", async () => {
  const harness = await createApiHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/ingest_event`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    assert.equal(response.status, 401);
  } finally {
    await harness.cleanup();
  }
});

test("POST /context_resolve returns 401 without authorization when apiKey is configured", async () => {
  const harness = await createApiHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/context_resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    assert.equal(response.status, 401);
  } finally {
    await harness.cleanup();
  }
});

test("POST /usage_ack returns 401 without authorization when apiKey is configured", async () => {
  const harness = await createApiHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/usage_ack`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    assert.equal(response.status, 401);
  } finally {
    await harness.cleanup();
  }
});

test("POST /usage_checkpoint returns 401 without authorization when apiKey is configured", async () => {
  const harness = await createApiHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/usage_checkpoint`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    assert.equal(response.status, 401);
  } finally {
    await harness.cleanup();
  }
});

test("POST /usage_fallback returns 401 without authorization when apiKey is configured", async () => {
  const harness = await createApiHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/usage_fallback`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    assert.equal(response.status, 401);
  } finally {
    await harness.cleanup();
  }
});

test("POST /usage_ack returns 200 with auth and a valid payload", async () => {
  const harness = await createApiHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/usage_ack`, {
      method: "POST",
      headers: {
        authorization: "Bearer top-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        checkpoint_id: "checkpoint-1",
        bundle_digest: "bundle-1",
        sufficiency: "sufficient",
        host_tier: "T2"
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ack: true });
  } finally {
    await harness.cleanup();
  }
});

test("POST /usage_ack accepts P7-011 memory feedback payloads", async () => {
  const harness = await createApiHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/usage_ack`, {
      method: "POST",
      headers: {
        authorization: "Bearer top-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        memory_id: "memory-1",
        ack_type: "accepted",
        context: {
          query: "phase7 local code audit",
          intent: "lookup",
          surface: "codex"
        },
        session_id: "session-1",
        event_id: "22222222-2222-4222-8222-222222222222",
        ts: "2026-04-23T08:00:00.000Z"
      })
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ack, true);
    assert.equal(body.memory_id, "memory-1");
    assert.equal(body.idempotent, false);
    assert.deepEqual(body.counters, {
      accepted: 1,
      rejected: 0,
      reranked: 0,
      total: 1
    });
  } finally {
    await harness.cleanup();
  }
});

test("POST /usage_checkpoint returns 200 with auth and a valid payload", async () => {
  const harness = await createApiHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/usage_checkpoint`, {
      method: "POST",
      headers: {
        authorization: "Bearer top-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        bundle_id: "bundle-1",
        checkpoint_id: "checkpoint-1",
        decision_state: "sufficient",
        used_items: ["wiki:wiki-1", "vega_memory:mem-1"],
        working_summary: "Host consumed bundle and identified next steps for implementation."
      })
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.checkpoint_id, "checkpoint-1");
    assert.equal(body.decision_state, "sufficient");
  } finally {
    await harness.cleanup();
  }
});

test("raw inbox migration remains idempotent across repeated startup calls", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);
    applyRawInboxMigration(db);

    const table = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      RAW_INBOX_TABLE
    );

    assert.equal(table?.name, RAW_INBOX_TABLE);
  } finally {
    db.close();
  }
});

test("context resolve HTTP handler returns a 400 validation response for invalid input", async () => {
  const handler = createContextResolveHttpHandler({
    resolve() {
      throw new Error("should not be called");
    }
  } as never);

  const response = {
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
  };

  await handler({ body: {} } as never, response as never);

  assert.equal(response.statusCode, 400);
  assert.equal((response.body as { error?: string }).error, "ValidationError");
});

test("context resolve HTTP handler returns 400 when followup omits prev_checkpoint_id", async () => {
  const handler = createContextResolveHttpHandler({
    resolve() {
      throw new Error("should not be called");
    }
  } as never);

  const response = {
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
  };

  await handler(
    {
      body: {
        intent: "followup",
        query: "checkpoint followup",
        surface: "codex",
        session_id: "session-1",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory"
      }
    } as never,
    response as never
  );

  assert.equal(response.statusCode, 400);
  assert.equal((response.body as { error?: string }).error, "ValidationError");
  assert.match(
    String((response.body as { detail?: string }).detail),
    /prev_checkpoint_id is required for followup intent/
  );
});

test("usage.ack HTTP handler returns a 400 validation response for invalid input", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const handler = createUsageAckHttpHandler(createAckStore(db));
    const response = {
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
    };

    await handler({ body: {} } as never, response as never);

    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error?: string }).error, "ValidationError");
  } finally {
    db.close();
  }
});

test("MCP server registers usage.ack", async () => {
  const harness = createMcpHarness();

  try {
    assert.equal(typeof getRegisteredTools(harness.server)["usage.ack"]?.handler, "function");
  } finally {
    await harness.cleanup();
  }
});

test("MCP server registers usage.checkpoint", async () => {
  const harness = createMcpHarness();

  try {
    assert.equal(typeof getRegisteredTools(harness.server)["usage.checkpoint"]?.handler, "function");
  } finally {
    await harness.cleanup();
  }
});

test("MCP server registers usage.fallback", async () => {
  const harness = createMcpHarness();

  try {
    assert.equal(typeof getRegisteredTools(harness.server)["usage.fallback"]?.handler, "function");
  } finally {
    await harness.cleanup();
  }
});

test("MCP server registers candidate promotion tools", async () => {
  const harness = createMcpHarness();

  try {
    const tools = getRegisteredTools(harness.server);

    assert.equal(typeof tools["candidate_create"]?.handler, "function");
    assert.equal(typeof tools["candidate_list"]?.handler, "function");
    assert.equal(typeof tools["candidate_promote"]?.handler, "function");
    assert.equal(typeof tools["candidate_demote"]?.handler, "function");
    assert.equal(typeof tools["candidate_evaluate"]?.handler, "function");
    assert.equal(typeof tools["candidate_sweep"]?.handler, "function");
  } finally {
    await harness.cleanup();
  }
});

test("MCP server registers circuit breaker tools", async () => {
  const harness = createMcpHarness();

  try {
    const tools = getRegisteredTools(harness.server);

    assert.equal(typeof tools["circuit_breaker_status"]?.handler, "function");
    assert.equal(typeof tools["circuit_breaker_reset"]?.handler, "function");
  } finally {
    await harness.cleanup();
  }
});
