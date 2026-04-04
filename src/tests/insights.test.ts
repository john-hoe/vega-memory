import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { InsightGenerator } from "../insights/generator.js";
import {
  detectProjectRiskAreas,
  detectTagClusters
} from "../insights/patterns.js";
import { SearchEngine } from "../search/engine.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 1.1,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
};

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  type: "pitfall",
  project: "vega",
  title: "Stored Memory",
  content: "Auth flow failed during deploy.",
  embedding: null,
  importance: 0.7,
  source: "auto",
  tags: ["auth"],
  created_at: "2026-04-03T00:00:00.000Z",
  updated_at: "2026-04-03T00:00:00.000Z",
  accessed_at: "2026-04-03T00:00:00.000Z",
  status: "active",
  verified: "unverified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const installEmbeddingMock = (): (() => void) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? "GET";

    if (method === "POST") {
      return new Response(
        JSON.stringify({
          embeddings: [[0.25, 0.75, 0.5]]
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
    globalThis.fetch = originalFetch;
  };
};

test("detectTagClusters finds clusters with >= 3 pitfalls on same tag", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createMemory(createStoredMemory({ id: "pitfall-1", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "pitfall-2", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "pitfall-3", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "pitfall-4", tags: ["cache"] }));

    const insights = detectTagClusters(repository);

    assert.deepEqual(insights, [
      {
        content: "Tag 'auth': 3 pitfalls recorded. Common issue area.",
        tags: ["auth"],
        project: "vega"
      }
    ]);
  } finally {
    repository.close();
  }
});

test("detectProjectRiskAreas identifies high-risk projects", () => {
  const repository = new Repository(":memory:");

  try {
    for (let index = 1; index <= 5; index += 1) {
      repository.createMemory(
        createStoredMemory({
          id: `pitfall-${index}`,
          project: "atlas",
          tags: index % 2 === 0 ? ["auth"] : ["deploy"]
        })
      );
    }

    const insights = detectProjectRiskAreas(repository);

    assert.deepEqual(insights, [
      {
        content: "Project 'atlas' has 5 pitfalls — higher risk area.",
        tags: ["auth", "deploy"],
        project: "atlas"
      }
    ]);
  } finally {
    repository.close();
  }
});

test("InsightGenerator creates new insight memories", async () => {
  const restoreFetch = installEmbeddingMock();
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const generator = new InsightGenerator(repository, memoryService);

  try {
    repository.createMemory(createStoredMemory({ id: "pitfall-1", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "pitfall-2", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "pitfall-3", tags: ["auth"] }));

    const created = await generator.generateInsights();
    const insights = repository.listMemories({
      type: "insight",
      project: "vega",
      status: "active",
      limit: 10
    });

    assert.equal(created, 1);
    assert.equal(insights.length, 1);
    assert.equal(
      insights[0]?.content,
      "Tag 'auth': 3 pitfalls recorded. Common issue area."
    );
    assert.deepEqual(insights[0]?.tags, ["auth"]);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("InsightGenerator does not duplicate existing insights", async () => {
  const restoreFetch = installEmbeddingMock();
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const generator = new InsightGenerator(repository, memoryService);

  try {
    repository.createMemory(createStoredMemory({ id: "pitfall-1", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "pitfall-2", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "pitfall-3", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "pitfall-4", tags: ["auth"] }));
    repository.createMemory(
      createStoredMemory({
        id: "insight-existing",
        type: "insight",
        content: "Tag 'auth': 3 pitfalls recorded. Common issue area.",
        tags: ["auth"],
        importance: 0.75
      })
    );

    const created = await generator.generateInsights();
    const insights = repository.listMemories({
      type: "insight",
      project: "vega",
      status: "active",
      limit: 10
    });

    assert.equal(created, 0);
    assert.equal(insights.length, 1);
    assert.equal(insights[0]?.id, "insight-existing");
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("sessionStart includes proactive warnings when task_hint matches insight tags", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-insights-session-"));
  const project = basename(tempDir);
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const recallService = new RecallService(repository, new SearchEngine(repository, baseConfig), baseConfig);
  const sessionService = new SessionService(repository, memoryService, recallService, baseConfig);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "insight-auth",
        type: "insight",
        project,
        content: "Tag 'auth': 3 pitfalls recorded. Common issue area.",
        tags: ["auth"],
        importance: 0.75
      })
    );

    const result = await sessionService.sessionStart(tempDir, "auth migration");

    assert.deepEqual(result.proactive_warnings, [
      "Tag 'auth': 3 pitfalls recorded. Common issue area."
    ]);
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
