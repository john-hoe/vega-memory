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
import { VegaSyncClient } from "../sync/client.js";
import { PendingQueue } from "../sync/queue.js";

interface TestHarness {
  baseUrl: string;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const createHarness = async (): Promise<TestHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-sync-"));
  const config: VegaConfig = {
    dbPath: join(tempDir, "memory.db"),
    ollamaBaseUrl: "http://localhost:99999",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    backupRetentionDays: 7,
    apiPort: 0,
    apiKey: undefined,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(tempDir, "cache.db")
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
    async cleanup(): Promise<void> {
      await server.stop();
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
    request(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);

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

test("VegaSyncClient.health returns offline status when server unreachable", async () => {
  const client = new VegaSyncClient("http://127.0.0.1:9", undefined);

  const result = await client.health();

  assert.deepEqual(result, {
    status: "offline"
  });
});

test("PendingQueue enqueue/dequeue/clear cycle", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-pending-cycle-"));
  const queue = new PendingQueue(tempDir);

  try {
    queue.enqueue({
      type: "store",
      params: {
        content: "Use SQLite for cache",
        type: "decision",
        project: "vega"
      },
      timestamp: "2026-04-04T00:00:00.000Z"
    });
    queue.enqueue({
      type: "session_end",
      params: {
        project: "vega",
        summary: "Completed sync client task."
      },
      timestamp: "2026-04-04T00:00:01.000Z"
    });

    const operations = queue.dequeue();

    assert.equal(operations.length, 2);
    assert.equal(operations[0]?.type, "store");
    assert.equal(operations[1]?.type, "session_end");

    queue.clear();

    assert.deepEqual(queue.dequeue(), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PendingQueue.count returns correct count", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-pending-count-"));
  const queue = new PendingQueue(tempDir);

  try {
    assert.equal(queue.count(), 0);

    queue.enqueue({
      type: "store",
      params: {
        content: "One pending operation",
        type: "insight",
        project: "vega"
      },
      timestamp: "2026-04-04T00:00:00.000Z"
    });
    queue.enqueue({
      type: "delete",
      params: {
        id: "memory-1"
      },
      timestamp: "2026-04-04T00:00:01.000Z"
    });

    assert.equal(queue.count(), 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("VegaSyncClient forwards store to server", async () => {
  const harness = await createHarness();
  const client = new VegaSyncClient(harness.baseUrl, undefined);

  try {
    const result = await client.store({
      content: "Remote sync should reach the server",
      type: "decision",
      project: "vega"
    });
    const listed = await readJson<Array<{ id: string; content: string }>>(
      await harness.request("/api/list?project=vega&limit=10")
    );

    assert.equal(result.action, "created");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, result.id);
    assert.match(listed[0]?.content ?? "", /Remote sync/);
  } finally {
    await harness.cleanup();
  }
});

test("VegaSyncClient falls back to queue when server offline", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-sync-offline-"));
  const queue = new PendingQueue(join(tempDir, "pending"));
  const client = new VegaSyncClient("http://127.0.0.1:9", undefined);

  client.setPendingQueue(queue);

  try {
    const result = await client.store({
      content: "Queue this while the server is offline",
      type: "decision",
      project: "vega"
    });

    assert.equal(result.action, "queued");
    assert.equal(queue.count(), 1);
    assert.equal(queue.dequeue()[0]?.type, "store");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
