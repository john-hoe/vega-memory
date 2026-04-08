import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { WebhookService } from "../integrations/webhooks.js";
import { SearchEngine } from "../search/engine.js";

interface TestHarness {
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const createHarness = async (webhooks?: VegaConfig["webhooks"]): Promise<TestHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-webhook-api-"));
  const config: VegaConfig = {
    dbPath: join(tempDir, "memory.db"),
    dbEncryption: false,
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
    cacheDbPath: join(tempDir, "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    ...(webhooks === undefined ? {} : { webhooks })
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

      return fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers
      });
    }
  };
};

test("WebhookService registers, lists, and removes webhooks", () => {
  const service = new WebhookService();

  service.registerWebhook({
    url: "https://jira.example/webhooks/memory",
    secret: "jira-secret",
    events: ["memory.created"],
    enabled: true
  });
  service.registerWebhook({
    url: "https://github.example/webhooks/memory",
    events: ["memory.updated"],
    enabled: false
  });

  assert.deepEqual(service.listWebhooks(), [
    {
      url: "https://jira.example/webhooks/memory",
      secret: "jira-secret",
      events: ["memory.created"],
      enabled: true
    },
    {
      url: "https://github.example/webhooks/memory",
      events: ["memory.updated"],
      enabled: false
    }
  ]);

  service.removeWebhook("https://jira.example/webhooks/memory");

  assert.deepEqual(service.listWebhooks(), [
    {
      url: "https://github.example/webhooks/memory",
      events: ["memory.updated"],
      enabled: false
    }
  ]);
});

test("WebhookService emit only logs enabled matching events", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const service = new WebhookService([
    {
      url: "https://jira.example/webhooks/memory",
      secret: "jira-secret",
      events: ["memory.created", "memory.updated"],
      enabled: true
    },
    {
      url: "https://github.example/webhooks/memory",
      events: ["memory.deleted"],
      enabled: true
    },
    {
      url: "https://custom.example/webhooks/memory",
      events: ["memory.created"],
      enabled: false
    }
  ], async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  });

  const result = await service.emit("memory.created", {
    id: "memory-1",
    project: "vega-memory"
  });
  const body = JSON.parse(String(requests[0]?.init?.body ?? "{}")) as {
    event: string;
    data: { id: string; project: string };
  };
  const headers = new Headers(requests[0]?.init?.headers);

  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(requests[0]?.url, "https://jira.example/webhooks/memory");
  assert.equal(body.event, "memory.created");
  assert.equal(body.data.id, "memory-1");
  assert.equal(headers.get("x-vega-signature"), service.signPayload(JSON.stringify(body), "jira-secret"));
});

test("WebhookService helper emitters delegate to the expected events", async () => {
  const events: string[] = [];
  const service = new WebhookService([
    {
      url: "https://hooks.example/webhooks/memory",
      events: ["memory.created", "memory.updated", "memory.deleted"],
      enabled: true
    }
  ], async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { event: string };
    events.push(body.event);
    return new Response(null, { status: 200 });
  });

  await service.emitMemoryCreated({
    id: "memory-1",
    content: "Webhook support added",
    project: "vega-memory"
  });
  await service.emitMemoryUpdated("memory-1");
  await service.emitMemoryDeleted("memory-1");

  assert.deepEqual(events, ["memory.created", "memory.updated", "memory.deleted"]);
});

test("WebhookService signPayload returns sha256 HMAC", () => {
  const service = new WebhookService();
  const payload = JSON.stringify({
    event: "memory.created",
    data: {
      id: "memory-1"
    }
  });

  assert.equal(
    service.signPayload(payload, "shared-secret"),
    createHmac("sha256", "shared-secret").update(payload).digest("hex")
  );
});

test("webhook API routes register, list, test, and delete webhooks", async () => {
  const originalFetch = global.fetch;

  global.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }

    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const harness = await createHarness();

  try {
    const createResponse = await harness.request("/api/webhooks", {
      method: "POST",
      body: JSON.stringify({
        url: "https://jira.example/webhooks/memory",
        secret: "jira-secret",
        events: ["memory.created"],
        enabled: true
      })
    });
    const created = await readJson<{
      url: string;
      secret?: string;
      events: string[];
      enabled: boolean;
    }>(createResponse);
    const listResponse = await harness.request("/api/webhooks");
    const listed = await readJson<
      Array<{
        url: string;
        secret?: string;
        events: string[];
        enabled: boolean;
      }>
    >(listResponse);
    const testResponse = await harness.request("/api/webhooks/test", {
      method: "POST",
      body: JSON.stringify({
        event: "memory.created",
        data: {
          id: "memory-1"
        }
      })
    });
    const tested = await readJson<{
      event: string;
      sent: number;
      failed: number;
    }>(testResponse);
    const deleteResponse = await harness.request(
      `/api/webhooks/${encodeURIComponent("https://jira.example/webhooks/memory")}`,
      {
        method: "DELETE"
      }
    );
    const deleted = await readJson<{ url: string; action: string }>(deleteResponse);
    const finalListResponse = await harness.request("/api/webhooks");
    const finalList = await readJson<Array<unknown>>(finalListResponse);

    assert.equal(createResponse.status, 201);
    assert.deepEqual(created, {
      url: "https://jira.example/webhooks/memory",
      secret: "jira-secret",
      events: ["memory.created"],
      enabled: true
    });
    assert.equal(listResponse.status, 200);
    assert.deepEqual(listed, [
      {
        url: "https://jira.example/webhooks/memory",
        secret: "jira-secret",
        events: ["memory.created"],
        enabled: true
      }
    ]);
    assert.equal(testResponse.status, 200);
    assert.deepEqual(tested, {
      event: "memory.created",
      sent: 1,
      failed: 0
    });
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(deleted, {
      url: "https://jira.example/webhooks/memory",
      action: "deleted"
    });
    assert.deepEqual(finalList, []);
  } finally {
    global.fetch = originalFetch;
    await harness.cleanup();
  }
});
