import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import type { Memory } from "../core/types.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { createMCPServer } from "../mcp/server.js";
import { SearchEngine } from "../search/engine.js";

const baseConfig = (tempDir: string): VegaConfig => ({
  dbPath: join(tempDir, "memory.db"),
  ollamaBaseUrl: "http://localhost:99999",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  dbEncryption: false,
  apiPort: 0,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: join(tempDir, "cache.db"),
  telegramBotToken: undefined,
  telegramChatId: undefined
});

const createMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  tenant_id: null,
  type: "project_context",
  project: "vega",
  title: "SQLite recall memory",
  content: "SQLite keeps the memory index local.",
  summary: null,
  embedding: null,
  importance: 0.7,
  source: "explicit",
  tags: ["sqlite", "recall"],
  created_at: "2026-04-05T00:00:00.000Z",
  updated_at: "2026-04-05T00:00:00.000Z",
  accessed_at: "2026-04-05T00:00:00.000Z",
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const EXPECTED_RECALL_KEYS = [
  "id",
  "type",
  "project",
  "title",
  "content",
  "importance",
  "source",
  "tags",
  "created_at",
  "updated_at",
  "accessed_at",
  "access_count",
  "status",
  "verified",
  "scope",
  "accessed_projects",
  "similarity",
  "finalScore"
];

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

test("HTTP /api/recall and MCP memory_recall return the same canonical field set", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-recall-protocol-"));
  const config = baseConfig(tempDir);
  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);
  const compactService = new CompactService(repository, config);
  const apiServer = createAPIServer(
    {
      repository,
      memoryService,
      recallService,
      sessionService,
      compactService
    },
    config
  );
  const mcpServer = createMCPServer({
    repository,
    graphService: {
      query: () => ({
        entity: null,
        relations: [],
        memories: []
      })
    },
    memoryService,
    recallService,
    sessionService,
    compactService,
    config
  });

  try {
    repository.createMemory(createMemory());

    const port = await apiServer.start(0);
    const httpResponse = await fetch(`http://127.0.0.1:${port}/api/recall`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: "SQLite",
        project: "vega",
        limit: 1,
        min_similarity: 0
      })
    });
    const httpPayload = (await httpResponse.json()) as Array<Record<string, unknown>>;
    const mcpResult = await getRegisteredTools(mcpServer).memory_recall.handler(
      {
        query: "SQLite",
        project: "vega",
        limit: 1,
        min_similarity: 0
      },
      {}
    );
    const mcpPayload = JSON.parse(mcpResult.content[0]?.text ?? "[]") as Array<Record<string, unknown>>;

    assert.equal(httpResponse.status, 200);
    assert.equal(httpPayload.length, 1);
    assert.equal(mcpPayload.length, 1);
    assert.deepEqual(Object.keys(httpPayload[0] ?? {}), EXPECTED_RECALL_KEYS);
    assert.deepEqual(Object.keys(mcpPayload[0] ?? {}), EXPECTED_RECALL_KEYS);
    assert.deepEqual(Object.keys(httpPayload[0] ?? {}), Object.keys(mcpPayload[0] ?? {}));
  } finally {
    await apiServer.stop();
    await mcpServer.close();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
