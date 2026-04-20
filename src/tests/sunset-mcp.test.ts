import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
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

function parseToolResult<T>(result: { isError?: boolean; content: Array<{ text?: string }> }): T {
  assert.equal(result.isError, undefined);
  assert.equal(typeof result.content[0]?.text, "string");
  return JSON.parse(result.content[0]?.text ?? "null") as T;
}

function createRegistryFile(contents: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "vega-sunset-mcp-"));
  const path = join(directory, "sunset-registry.yaml");
  writeFileSync(path, contents, "utf8");
  return { directory, path };
}

function createHarness() {
  const repository = new Repository(":memory:");
  const server = createMCPServer({
    repository,
    graphService,
    memoryService,
    recallService,
    sessionService,
    compactService,
    config: BASE_CONFIG,
    homeDir: ""
  });

  return {
    server,
    async cleanup(): Promise<void> {
      await server.close();
      repository.close();
    }
  };
}

test("sunset.check returns ready and pending candidates on the happy path", async () => {
  const { directory, path } = createRegistryFile(`
sunsets:
  - id: legacy-ready-route
    type: api_route
    target: POST /memory_store
    deprecated_since: 2020-01-01
    criteria:
      time_based:
        min_days_since_deprecated: 1
    notification:
      changelog: true
      log_level: warn
  - id: legacy-pending-route
    type: api_route
    target: GET /search
    deprecated_since: 2026-01-15
    criteria:
      usage_threshold:
        metric: vega_api_route_calls_total
        window_days: 30
        max_calls: 10
    notification:
      changelog: false
      log_level: info
`);
  const harness = createHarness();

  try {
    const handler = getRegisteredTools(harness.server)["sunset.check"]?.handler;
    assert.equal(typeof handler, "function");

    const result = parseToolResult<{
      schema_version: string;
      evaluated_at: string;
      candidates: Array<{ candidate_id: string; status: string }>;
      degraded?: string;
    }>(await handler({ registry_path: path }, {}));

    assert.equal(result.schema_version, "1.0");
    assert.equal(result.degraded, undefined);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.candidate_id, candidate.status]),
      [
        ["legacy-ready-route", "ready"],
        ["legacy-pending-route", "pending"]
      ]
    );
  } finally {
    await harness.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sunset.check returns registry_missing when the registry file does not exist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vega-sunset-mcp-missing-"));
  const path = join(directory, "missing.yaml");
  const harness = createHarness();

  try {
    const handler = getRegisteredTools(harness.server)["sunset.check"]?.handler;
    assert.equal(typeof handler, "function");

    const result = parseToolResult<{
      schema_version: string;
      evaluated_at: string;
      candidates: Array<{ candidate_id: string; status: string }>;
      degraded?: string;
    }>(await handler({ registry_path: path }, {}));

    assert.equal(result.degraded, "registry_missing");
    assert.deepEqual(result.candidates, []);
  } finally {
    await harness.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sunset.check returns parse_error when the registry YAML is invalid", async () => {
  const { directory, path } = createRegistryFile(`
sunsets:
  - id: invalid-entry
    type api_route
`);
  const harness = createHarness();

  try {
    const handler = getRegisteredTools(harness.server)["sunset.check"]?.handler;
    assert.equal(typeof handler, "function");

    const result = parseToolResult<{
      schema_version: string;
      evaluated_at: string;
      candidates: Array<{ candidate_id: string; status: string }>;
      degraded?: string;
    }>(await handler({ registry_path: path }, {}));

    assert.equal(result.degraded, "parse_error");
    assert.deepEqual(result.candidates, []);
  } finally {
    await harness.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});
