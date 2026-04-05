import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";

interface TestHarness {
  baseUrl: string;
  config: VegaConfig;
  repository: Repository;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const createHarness = async (apiKey?: string): Promise<TestHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-api-"));
  const config: VegaConfig = {
    dbPath: join(tempDir, "memory.db"),
    ollamaBaseUrl: "http://localhost:99999",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    backupRetentionDays: 7,
    apiPort: 0,
    apiKey,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(tempDir, "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    observerEnabled: false,
  };
  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(
    repository,
    memoryService,
    recallService,
    config
  );
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
    baseUrl,
    config,
    repository,
    async cleanup(): Promise<void> {
      await server.stop();
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
    request(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);
      if (apiKey) {
        headers.set("authorization", `Bearer ${apiKey}`);
      }
      if (init?.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      return fetch(`${baseUrl}${path}`, {
        ...init,
        headers
      });
    }
  };
};

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

test("GET /api/health returns the expanded health payload", async () => {
  const harness = await createHarness();

  try {
    const response = await harness.request("/api/health");
    const body = await readJson<{
      status: string;
      ollama: boolean;
      db_integrity: boolean;
      memories: number;
      latency_avg_ms: number;
      db_size_mb: number;
      last_backup: string | null;
      issues: string[];
      fix_suggestions: string[];
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(typeof body.status, "string");
    assert.equal(typeof body.ollama, "boolean");
    assert.equal(typeof body.db_integrity, "boolean");
    assert.equal(typeof body.memories, "number");
    assert.equal(typeof body.latency_avg_ms, "number");
    assert.equal(typeof body.db_size_mb, "number");
    assert.equal(Array.isArray(body.issues), true);
    assert.equal(Array.isArray(body.fix_suggestions), true);
  } finally {
    await harness.cleanup();
  }
});

test("POST /api/store creates a memory and GET /api/list returns it", async () => {
  const harness = await createHarness();

  try {
    const storeResponse = await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "Use SQLite for local memory storage",
        type: "decision",
        project: "vega"
      })
    });
    const stored = await readJson<{
      id: string;
      action: string;
      title: string;
    }>(storeResponse);
    const listResponse = await harness.request("/api/list?project=vega&limit=10");
    const listed = await readJson<
      Array<{
        id: string;
        content: string;
        project: string;
      }>
    >(listResponse);

    assert.equal(storeResponse.status, 200);
    assert.equal(stored.action, "created");
    assert.equal(listResponse.status, 200);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, stored.id);
    assert.match(listed[0]?.content ?? "", /SQLite/);
  } finally {
    await harness.cleanup();
  }
});

test("POST /api/recall with query returns results", async () => {
  const harness = await createHarness();

  try {
    await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "SQLite keeps the memory index local",
        type: "project_context",
        project: "vega"
      })
    });

    const response = await harness.request("/api/recall", {
      method: "POST",
      body: JSON.stringify({
        query: "SQLite",
        project: "vega",
        limit: 5,
        min_similarity: 0
      })
    });
    const results = await readJson<
      Array<{
        id: string;
        content: string;
        project: string;
      }>
    >(response);

    assert.equal(response.status, 200);
    assert.equal(results.length, 1);
    assert.match(results[0]?.content ?? "", /SQLite/);
  } finally {
    await harness.cleanup();
  }
});

test("PATCH /api/memory/:id updates a memory", async () => {
  const harness = await createHarness();

  try {
    const storeResponse = await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "Initial API memory",
        type: "insight",
        project: "vega"
      })
    });
    const stored = await readJson<{ id: string }>(storeResponse);
    const patchResponse = await harness.request(`/api/memory/${stored.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: "Updated API memory",
        tags: ["api", "updated"]
      })
    });
    const listed = await readJson<
      Array<{
        id: string;
        content: string;
        tags: string[];
      }>
    >(await harness.request("/api/list?project=vega&limit=10"));

    assert.equal(patchResponse.status, 200);
    assert.equal(listed[0]?.id, stored.id);
    assert.equal(listed[0]?.content, "Updated API memory");
    assert.deepEqual(listed[0]?.tags, ["api", "updated"]);
  } finally {
    await harness.cleanup();
  }
});

test("DELETE /api/memory/:id removes a memory", async () => {
  const harness = await createHarness();

  try {
    const storeResponse = await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "Delete me through the API",
        type: "insight",
        project: "vega"
      })
    });
    const stored = await readJson<{ id: string }>(storeResponse);
    const deleteResponse = await harness.request(`/api/memory/${stored.id}`, {
      method: "DELETE"
    });
    const listed = await readJson<Array<{ id: string }>>(
      await harness.request("/api/list?project=vega&limit=10")
    );

    assert.equal(deleteResponse.status, 200);
    assert.equal(listed.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("POST /api/session/start returns session context", async () => {
  const harness = await createHarness();
  const workingDirectory = mkdtempSync(join(tmpdir(), "vega-api-session-start-"));

  try {
    const response = await harness.request("/api/session/start", {
      method: "POST",
      body: JSON.stringify({
        working_directory: workingDirectory,
        task_hint: "health endpoint"
      })
    });
    const body = await readJson<{
      project: string;
      active_tasks: unknown[];
      preferences: unknown[];
      context: unknown[];
      relevant: unknown[];
      recent_unverified: unknown[];
      conflicts: unknown[];
      proactive_warnings: string[];
      token_estimate: number;
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.project.length > 0, true);
    assert.equal(Array.isArray(body.active_tasks), true);
    assert.equal(typeof body.token_estimate, "number");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
    await harness.cleanup();
  }
});

test("POST /api/session/end records session", async () => {
  const harness = await createHarness();

  try {
    const response = await harness.request("/api/session/end", {
      method: "POST",
      body: JSON.stringify({
        project: "vega",
        summary: "我们决定使用 SQLite。",
        completed_tasks: []
      })
    });
    const body = await readJson<{
      project: string;
      action: string;
    }>(response);
    const sessionCount = harness.repository.db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM sessions")
      .get()
      ?.count;

    assert.equal(response.status, 200);
    assert.equal(body.project, "vega");
    assert.equal(body.action, "ended");
    assert.equal(sessionCount, 1);
  } finally {
    await harness.cleanup();
  }
});

test("POST /api/compact returns merged and archived counts", async () => {
  const harness = await createHarness();

  try {
    await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "Archive me during compaction",
        type: "insight",
        project: "vega",
        importance: 0.05
      })
    });

    const response = await harness.request("/api/compact", {
      method: "POST",
      body: JSON.stringify({
        project: "vega"
      })
    });
    const body = await readJson<{
      merged: number;
      archived: number;
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(typeof body.merged, "number");
    assert.equal(body.archived, 1);
  } finally {
    await harness.cleanup();
  }
});

test("unauthorized request without API key returns 401 when apiKey is set", async () => {
  const harness = await createHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/api/health`);
    const body = await readJson<{ error: string }>(response);

    assert.equal(response.status, 401);
    assert.equal(body.error, "unauthorized");
  } finally {
    await harness.cleanup();
  }
});

test("no auth is required when apiKey is undefined", async () => {
  const harness = await createHarness();

  try {
    const response = await fetch(`${harness.baseUrl}/api/health`);

    assert.equal(response.status, 200);
  } finally {
    await harness.cleanup();
  }
});
