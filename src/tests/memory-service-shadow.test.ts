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
import { embeddingCache } from "../embedding/cache.js";
import { queryRawInbox } from "../ingestion/raw-inbox.js";
import { SearchEngine } from "../search/engine.js";

const FEATURE_FLAG = "VEGA_SHADOW_DUAL_WRITE";
const NOW = "2026-04-17T00:00:00.000Z";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  apiPort: 0,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  dbEncryption: false
};

const createEmbeddingBuffer = (values: number[]): Buffer => Buffer.from(new Float32Array(values).buffer);

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "44444444-4444-4444-8444-444444444444",
  tenant_id: null,
  type: "decision",
  project: "vega",
  title: "Stored Memory",
  content: "Persist SQLite decisions for local development.",
  summary: "Persist SQLite decisions for local development.",
  embedding: createEmbeddingBuffer([0.2, 0.8]),
  importance: 0.7,
  source: "auto",
  tags: ["sqlite"],
  created_at: NOW,
  updated_at: NOW,
  accessed_at: NOW,
  status: "active",
  verified: "unverified",
  scope: "project",
  accessed_projects: ["vega"],
  source_context: null,
  ...overrides
});

const installEmbeddingMock = (vector: number[]): (() => void) => {
  const originalFetch = globalThis.fetch;
  embeddingCache.clear();

  globalThis.fetch = async (input, init) => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (!target.startsWith(baseConfig.ollamaBaseUrl)) {
      return originalFetch(input, init);
    }

    const method = init?.method ?? "GET";
    if (method === "POST") {
      return new Response(
        JSON.stringify({
          embeddings: [vector]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return new Response(JSON.stringify({ version: "mock" }), { status: 200 });
  };

  return () => {
    embeddingCache.clear();
    globalThis.fetch = originalFetch;
  };
};

const withFeatureFlag = async (value: string | undefined, run: () => Promise<void>): Promise<void> => {
  const previous = process.env[FEATURE_FLAG];

  if (value === undefined) {
    delete process.env[FEATURE_FLAG];
  } else {
    process.env[FEATURE_FLAG] = value;
  }

  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[FEATURE_FLAG];
    } else {
      process.env[FEATURE_FLAG] = previous;
    }
  }
};

const createApiHarness = async (): Promise<{
  repository: Repository;
  request(path: string, init?: RequestInit): Promise<Response>;
  cleanup(): Promise<void>;
}> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-shadow-api-"));
  const config: VegaConfig = {
    ...baseConfig,
    dbPath: join(tempDir, "memory.db"),
    cacheDbPath: join(tempDir, "cache.db")
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
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    repository,
    request(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);
      if (init?.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      return fetch(`${baseUrl}${path}`, {
        ...init,
        headers
      });
    },
    async cleanup(): Promise<void> {
      await server.stop();
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
};

test("MemoryService.store matched updates invoke the optional shadow callback with the updated memory", async () => {
  const restoreFetch = installEmbeddingMock([0.2, 0.8]);
  const repository = new Repository(":memory:");
  const shadowCalls: Memory[] = [];
  const service = new MemoryService(repository, baseConfig, undefined, undefined, undefined, undefined, (memory) => {
    shadowCalls.push(memory);
  });

  try {
    repository.createMemory(createStoredMemory());

    const result = await service.store({
      content: "Persist SQLite decisions for local development.\n\nKeep WAL mode enabled for tests.",
      type: "decision",
      project: "vega",
      source: "explicit"
    });

    const updated = repository.getMemory("44444444-4444-4444-8444-444444444444");

    assert.equal(result.action, "updated");
    assert.equal(shadowCalls.length, 1);
    assert.ok(updated);
    assert.deepEqual(shadowCalls[0], updated);
    assert.match(updated?.content ?? "", /Keep WAL mode enabled for tests/);
    assert.equal(updated?.source, "explicit");
    assert.equal(updated?.verified, "verified");
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("MemoryService.store create path does not invoke the optional shadow callback directly", async () => {
  const restoreFetch = installEmbeddingMock([0.2, 0.8]);
  const repository = new Repository(":memory:");
  const shadowCalls: Memory[] = [];
  const service = new MemoryService(repository, baseConfig, undefined, undefined, undefined, undefined, (memory) => {
    shadowCalls.push(memory);
  });

  try {
    const result = await service.store({
      content: "Create a brand new memory without similarity matches.",
      type: "decision",
      project: "vega"
    });

    assert.equal(result.action, "created");
    assert.equal(shadowCalls.length, 0);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("repository.updateMemory outside MemoryService does not invoke the optional shadow callback", () => {
  const repository = new Repository(":memory:");
  const shadowCalls: Memory[] = [];
  void new MemoryService(repository, baseConfig, undefined, undefined, undefined, undefined, (memory) => {
    shadowCalls.push(memory);
  });

  try {
    repository.createMemory(createStoredMemory());

    repository.updateMemory("44444444-4444-4444-8444-444444444444", {
      content: "Maintenance update should stay local.",
      updated_at: "2026-04-17T00:05:00.000Z"
    });

    assert.equal(shadowCalls.length, 0);
  } finally {
    repository.close();
  }
});

test("API store matched-update path writes one shadow row while direct preseed creates none", async () => {
  await withFeatureFlag("true", async () => {
    const restoreFetch = installEmbeddingMock([0.2, 0.8]);
    const harness = await createApiHarness();

    try {
      harness.repository.createMemory(createStoredMemory());
      assert.equal(queryRawInbox(harness.repository.db).length, 0);

      const response = await harness.request("/api/store", {
        method: "POST",
        body: JSON.stringify({
          content: "Persist SQLite decisions for local development.\n\nKeep WAL mode enabled for tests.",
          type: "decision",
          project: "vega",
          source: "explicit",
          source_actor: "codex"
        })
      });
      const body = (await response.json()) as {
        action: string;
        id: string;
      };
      const rows = queryRawInbox(harness.repository.db);

      assert.equal(response.status, 200);
      assert.equal(body.action, "updated");
      assert.equal(body.id, "44444444-4444-4444-8444-444444444444");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_id, body.id);
      assert.equal(rows[0]?.surface, "api");
    } finally {
      await harness.cleanup();
      restoreFetch();
    }
  });
});
