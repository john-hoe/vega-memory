import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { PostgresAdapter } from "../db/postgres-adapter.js";
import { createMCPServer, type CreateMCPServerOptions } from "../mcp/server.js";

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

const graphService: CreateMCPServerOptions["graphService"] = {
  query: async () => ({ entity: null, relations: [], memories: [] }),
  getNeighbors: async () => ({ entity: null, neighbors: [], relations: [], memories: [] }),
  shortestPath: async () => ({ from: null, to: null, entities: [], relations: [], memories: [], found: false }),
  graphStats: async () => ({
    total_entities: 0,
    total_relations: 0,
    entity_types: {},
    relation_types: {},
    average_confidence: null,
    tracked_code_files: 0,
    tracked_doc_files: 0
  }),
  subgraph: async () => ({ seed_entities: [], missing_entities: [], entities: [], relations: [], memories: [] })
};

const memoryService: CreateMCPServerOptions["memoryService"] = {
  store: async () => ({ id: "unused", action: "created", title: "unused" }),
  update: async () => {},
  delete: async () => {}
};

const recallService: CreateMCPServerOptions["recallService"] = {
  recall: async () => [],
  listMemories: () => []
};

const sessionService: CreateMCPServerOptions["sessionService"] = {
  sessionStart: async () => ({
    project: "vega-memory",
    active_tasks: [],
    preferences: [],
    context: [],
    relevant: [],
    relevant_wiki_pages: [],
    wiki_drafts_pending: 0,
    recent_unverified: [],
    conflicts: [],
    proactive_warnings: [],
    token_estimate: 0
  }),
  sessionEnd: async () => {}
};

const compactService: CreateMCPServerOptions["compactService"] = {
  compact: async () => ({
    merged: 0,
    archived: 0
  })
};

type RegisteredToolHandler = (
  args: Record<string, unknown>,
  extra: object
) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;

const getRegisteredTools = (
  server: ReturnType<typeof createMCPServer>
): Record<string, { handler: RegisteredToolHandler }> =>
  (
    server as unknown as {
      _registeredTools: Record<string, { handler: RegisteredToolHandler }>;
    }
  )._registeredTools;

function writeHomeFile(homeDir: string, relativePath: string, content: string): string {
  const fullPath = join(homeDir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

function parseToolResult<T>(result: { isError?: boolean; content: Array<{ text?: string }> }): T {
  assert.equal(result.isError, undefined);
  assert.equal(typeof result.content[0]?.text, "string");
  return JSON.parse(result.content[0]?.text ?? "null") as T;
}

function restoreEnv(
  key: "VEGA_HOST_MEMORY_FILE_ENABLED",
  previousValue: string | undefined
): void {
  if (previousValue === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = previousValue;
}

function createSqliteHarness(homeDir: string) {
  const repository = new Repository(":memory:");
  const server = createMCPServer({
    repository,
    graphService,
    memoryService,
    recallService,
    sessionService,
    compactService,
    config: BASE_CONFIG,
    homeDir
  });

  return {
    repository,
    server,
    async cleanup(): Promise<void> {
      await server.close();
      repository.close();
    }
  };
}

function createPostgresHarness() {
  const repository = {
    db: new PostgresAdapter({
      host: "localhost",
      port: 5432,
      database: "vega"
    }) as Repository["db"],
    listMemories: () => [],
    logPerformance: () => {}
  } as unknown as Repository;
  const server = createMCPServer({
    repository,
    graphService,
    memoryService,
    recallService,
    sessionService,
    compactService,
    config: {
      ...BASE_CONFIG,
      databaseType: "postgres"
    },
    homeDir: ""
  });

  return {
    server,
    async cleanup(): Promise<void> {
      await server.close();
    }
  };
}

test("host_memory_file.refresh returns refresh metadata on sqlite", async () => {
  const previousEnabled = process.env.VEGA_HOST_MEMORY_FILE_ENABLED;
  const homeDir = mkdtempSync(join(tmpdir(), "vega-host-memory-mcp-sqlite-"));
  const harness = createSqliteHarness(homeDir);

  process.env.VEGA_HOST_MEMORY_FILE_ENABLED = "true";

  try {
    writeHomeFile(homeDir, ".omc/notepad.md", "manual refresh keyword from MCP");

    const handler = getRegisteredTools(harness.server)["host_memory_file.refresh"]?.handler;
    assert.equal(typeof handler, "function");

    const result = parseToolResult<{
      schema_version: string;
      refreshed_at: string;
      indexed_paths: number;
      duration_ms: number;
      degraded?: string;
    }>(await handler({}, {}));

    assert.equal(result.schema_version, "1.0");
    assert.match(result.refreshed_at, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(result.indexed_paths >= 1, true);
    assert.equal(result.duration_ms >= 0, true);
    assert.equal(result.degraded, undefined);
  } finally {
    restoreEnv("VEGA_HOST_MEMORY_FILE_ENABLED", previousEnabled);
    await harness.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("host_memory_file.refresh returns adapter_disabled when disabled by env", async () => {
  const previousEnabled = process.env.VEGA_HOST_MEMORY_FILE_ENABLED;
  const homeDir = mkdtempSync(join(tmpdir(), "vega-host-memory-mcp-disabled-"));
  const harness = createSqliteHarness(homeDir);

  process.env.VEGA_HOST_MEMORY_FILE_ENABLED = "false";

  try {
    const handler = getRegisteredTools(harness.server)["host_memory_file.refresh"]?.handler;
    assert.equal(typeof handler, "function");

    const result = parseToolResult<{
      schema_version: string;
      refreshed_at: string;
      indexed_paths: number;
      duration_ms: number;
      degraded?: string;
    }>(await handler({}, {}));

    assert.equal(result.schema_version, "1.0");
    assert.equal(result.degraded, "adapter_disabled");
    assert.equal(result.indexed_paths >= 0, true);
    assert.equal(result.duration_ms >= 0, true);
  } finally {
    restoreEnv("VEGA_HOST_MEMORY_FILE_ENABLED", previousEnabled);
    await harness.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("host_memory_file.refresh returns sqlite_only on postgres-backed repositories", async () => {
  const previousEnabled = process.env.VEGA_HOST_MEMORY_FILE_ENABLED;
  const harness = createPostgresHarness();

  process.env.VEGA_HOST_MEMORY_FILE_ENABLED = "true";

  try {
    const handler = getRegisteredTools(harness.server)["host_memory_file.refresh"]?.handler;
    assert.equal(typeof handler, "function");

    const result = parseToolResult<{
      schema_version: string;
      refreshed_at: string;
      indexed_paths: number;
      duration_ms: number;
      degraded?: string;
    }>(await handler({}, {}));

    assert.equal(result.schema_version, "1.0");
    assert.equal(result.degraded, "sqlite_only");
    assert.equal(result.indexed_paths, 0);
    assert.equal(result.duration_ms >= 0, true);
  } finally {
    restoreEnv("VEGA_HOST_MEMORY_FILE_ENABLED", previousEnabled);
    await harness.cleanup();
  }
});
