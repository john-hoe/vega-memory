import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { PostgresAdapter } from "../db/postgres-adapter.js";
import { createMCPServer } from "../mcp/server.js";
import {
  createReconciliationRunMcpTool,
  ReconciliationOrchestrator
} from "../reconciliation/index.js";
import { SearchEngine } from "../search/engine.js";

const BASE_CONFIG: VegaConfig = {
  dbPath: ":memory:",
  dbEncryption: false,
  databaseType: "sqlite",
  embeddingProvider: "ollama",
  ollamaBaseUrl: "http://localhost:99999",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  apiPort: 0,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: ":memory:",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  slackWebhookUrl: undefined,
  slackBotToken: undefined,
  slackChannel: undefined,
  slackEnabled: false,
  stripeSecretKey: undefined,
  stripeWebhookSecret: undefined,
  stripePublishableKey: undefined,
  stripeEnabled: false,
  oidcIssuerUrl: undefined,
  oidcClientId: undefined,
  oidcClientSecret: undefined,
  oidcCallbackUrl: undefined,
  redisUrl: undefined,
  redisHost: undefined,
  redisPort: undefined,
  redisPassword: undefined,
  redisDb: undefined,
  redisEnabled: false,
  pgHost: undefined,
  pgPort: undefined,
  pgDatabase: undefined,
  pgUser: undefined,
  pgPassword: undefined,
  pgSsl: undefined,
  pgSchema: undefined,
  cloudBackup: undefined,
  customRedactionPatterns: []
};

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

function createSqliteHarness() {
  const repository = new Repository(":memory:");
  const searchEngine = new SearchEngine(repository, BASE_CONFIG);
  const memoryService = new MemoryService(repository, BASE_CONFIG);
  const recallService = new RecallService(repository, searchEngine, BASE_CONFIG);
  const sessionService = new SessionService(repository, memoryService, recallService, BASE_CONFIG);
  const compactService = new CompactService(repository, BASE_CONFIG);
  const server = createMCPServer({
    repository,
    graphService,
    memoryService,
    recallService,
    sessionService,
    compactService,
    config: BASE_CONFIG
  });

  return {
    server,
    async cleanup(): Promise<void> {
      await server.close();
      repository.close();
    }
  };
}

test("MCP server registers reconciliation.run", async () => {
  const harness = createSqliteHarness();

  try {
    assert.equal(typeof getRegisteredTools(harness.server)["reconciliation.run"]?.handler, "function");
  } finally {
    await harness.cleanup();
  }
});

test("createReconciliationRunMcpTool returns sqlite_only degraded output when unavailable", async () => {
  const tool = createReconciliationRunMcpTool(undefined, {
    now: () => Date.parse("2026-04-21T00:00:00.000Z")
  });

  const result = await tool.invoke({});

  assert.deepEqual(result, {
    schema_version: "1.0",
    degraded: "sqlite_only"
  });
});

test("createReconciliationRunMcpTool validates the reconciliation window", async () => {
  const repository = new Repository(":memory:");

  try {
    const tool = createReconciliationRunMcpTool(
      new ReconciliationOrchestrator({
        db: repository.db,
        now: () => Date.parse("2026-04-21T00:00:00.000Z")
      }),
      {
        now: () => Date.parse("2026-04-21T00:00:00.000Z")
      }
    );

    await assert.rejects(
      () =>
        tool.invoke({
          window_start: 10,
          window_end: 10
        }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "ZodError"
    );
  } finally {
    repository.close();
  }
});

test("createReconciliationRunMcpTool runs the orchestrator with default inputs", async () => {
  const repository = new Repository(":memory:");

  try {
    const tool = createReconciliationRunMcpTool(
      new ReconciliationOrchestrator({
        db: repository.db,
        now: () => Date.parse("2026-04-21T00:00:00.000Z")
      }),
      {
        now: () => Date.parse("2026-04-21T00:00:00.000Z")
      }
    );

    const result = await tool.invoke({});

    if ("degraded" in result) {
      assert.fail("expected a reconciliation report");
    }

    assert.equal(result.schema_version, "1.0");
    assert.equal(typeof result.run_id, "string");
    assert.deepEqual(
      result.dimensions.map((dimension) => dimension.dimension),
      ["count", "shape", "semantic", "ordering"]
    );
  } finally {
    repository.close();
  }
});

test("postgres-backed repositories are exposed to the reconciliation tool as sqlite_only degraded", async () => {
  const repository = new Repository(
    new PostgresAdapter({
      host: "localhost",
      port: 5432,
      database: "vega"
    })
  );

  try {
    const tool = createReconciliationRunMcpTool(
      repository.db.isPostgres
        ? undefined
        : new ReconciliationOrchestrator({
            db: repository.db
          })
    );

    const result = await tool.invoke({});

    assert.deepEqual(result, {
      schema_version: "1.0",
      degraded: "sqlite_only"
    });
  } finally {
    repository.close = () => {};
  }
});
