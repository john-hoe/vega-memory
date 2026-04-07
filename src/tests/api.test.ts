import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createAPIServer } from "../api/server.js";
import {
  DASHBOARD_AUTH_COOKIE,
  DASHBOARD_SESSION_MAX_AGE_MS,
  hasDashboardSession,
  pruneStaleSessions,
  registerDashboardSession,
  revokeDashboardSession
} from "../api/auth.js";
import type { VegaConfig } from "../config.js";
import { BillingService } from "../core/billing.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { TenantService } from "../core/tenant.js";
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
      if (apiKey && !headers.has("authorization")) {
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

test("GET /api/analytics returns 400 for an invalid since value", async () => {
  const harness = await createHarness();

  try {
    const response = await harness.request("/api/analytics?since=not-a-date");
    const body = await readJson<{ error: string }>(response);

    assert.equal(response.status, 400);
    assert.equal(body.error, "since must be a valid date");
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

test("GET /api/recall/stream frames SSE payloads without leaking injected event lines", async () => {
  const harness = await createHarness();

  try {
    await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "SQLite keeps the memory index local\n\nevent: hacked\n\ndata: injected",
        type: "project_context",
        project: "vega"
      })
    });

    const response = await harness.request(
      "/api/recall/stream?query=SQLite&project=vega&limit=1&min_similarity=0"
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(body, /^data: /m);
    assert.match(body, /event: end\n/);
    assert.equal(body.includes("\nevent: hacked\n"), false);
    assert.equal(body.includes("\ndata: injected\n"), false);
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

test("dashboard session cookie authorizes API requests when apiKey is set", async () => {
  const harness = await createHarness("top-secret");
  const sessionToken = "dashboard-session-token";

  registerDashboardSession(harness.config, sessionToken);

  try {
    const response = await fetch(`${harness.baseUrl}/api/health`, {
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE}=${sessionToken}`
      }
    });

    assert.equal(response.status, 200);
  } finally {
    revokeDashboardSession(harness.config, sessionToken);
    await harness.cleanup();
  }
});

test("tenant API key authorizes API requests and stores tenant ownership", async () => {
  const harness = await createHarness("top-secret");
  const tenantService = new TenantService(harness.repository);
  const tenant = tenantService.createTenant("Acme", "pro");

  try {
    const storeResponse = await harness.request("/api/store", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tenant.api_key}`
      },
      body: JSON.stringify({
        content: "Tenant-scoped memory written through the API",
        type: "decision",
        project: "tenant-project"
      })
    });
    const stored = await readJson<{ id: string; action: string }>(storeResponse);
    const memory = harness.repository.getMemory(stored.id);
    const performanceEntry = harness.repository.db
      .prepare<
        [],
        {
          operation: string;
          tenant_id: string | null;
        }
      >(
        `SELECT operation, tenant_id
         FROM performance_log
         ORDER BY rowid DESC
         LIMIT 1`
      )
      .get();

    assert.equal(storeResponse.status, 200);
    assert.equal(stored.action, "created");
    assert.equal(memory?.tenant_id, tenant.id);
    assert.equal(performanceEntry?.operation, "POST /api/store");
    assert.equal(performanceEntry?.tenant_id, tenant.id);
  } finally {
    await harness.cleanup();
  }
});

test("root API key still authorizes API requests when tenant auth is enabled", async () => {
  const harness = await createHarness("top-secret");

  try {
    const response = await harness.request("/api/list?limit=1");

    assert.equal(response.status, 200);
  } finally {
    await harness.cleanup();
  }
});

test("invalid bearer token returns 401 when API auth is enabled", async () => {
  const harness = await createHarness("top-secret");

  try {
    const response = await harness.request("/api/list?limit=1", {
      headers: {
        authorization: "Bearer invalid-key"
      }
    });
    const body = await readJson<{ error: string }>(response);

    assert.equal(response.status, 401);
    assert.equal(body.error, "unauthorized");
  } finally {
    await harness.cleanup();
  }
});

test("deactivated tenant API key returns 401", async () => {
  const harness = await createHarness("top-secret");
  const tenantService = new TenantService(harness.repository);
  const tenant = tenantService.createTenant("Inactive", "free");

  tenantService.deactivateTenant(tenant.id);

  try {
    const response = await harness.request("/api/list?limit=1", {
      headers: {
        authorization: `Bearer ${tenant.api_key}`
      }
    });
    const body = await readJson<{ error: string }>(response);

    assert.equal(response.status, 401);
    assert.equal(body.error, "unauthorized");
  } finally {
    await harness.cleanup();
  }
});

test("billing counts API request log rows for tenant traffic", async () => {
  const harness = await createHarness("top-secret");
  const tenantService = new TenantService(harness.repository);
  const billingService = new BillingService(harness.repository);
  const tenant = tenantService.createTenant("Billing", "pro");
  const month = new Date().toISOString().slice(0, 7);

  try {
    const tenantHeaders = {
      authorization: `Bearer ${tenant.api_key}`
    };

    await harness.request("/api/store", {
      method: "POST",
      headers: tenantHeaders,
      body: JSON.stringify({
        content: "Count this tenant API store call",
        type: "decision",
        project: "billing"
      })
    });
    await harness.request("/api/list?project=billing&limit=10", {
      headers: tenantHeaders
    });
    await harness.request("/api/health", {
      headers: tenantHeaders
    });

    const usage = billingService.getUsageForBilling(tenant.id, month);

    assert.equal(usage.api_calls, 2);
  } finally {
    await harness.cleanup();
  }
});

test("tenant-scoped list and recall endpoints do not leak cross-tenant memories", async () => {
  const harness = await createHarness("top-secret");
  const tenantService = new TenantService(harness.repository);
  const tenantA = tenantService.createTenant("Tenant A", "pro");
  const tenantB = tenantService.createTenant("Tenant B", "pro");
  const tenantAHeaders = {
    authorization: `Bearer ${tenantA.api_key}`
  };
  const tenantBHeaders = {
    authorization: `Bearer ${tenantB.api_key}`
  };

  try {
    await harness.request("/api/store", {
      method: "POST",
      headers: tenantAHeaders,
      body: JSON.stringify({
        content: "shared isolation token from tenant alpha",
        type: "decision",
        project: "tenant-project"
      })
    });
    await harness.request("/api/store", {
      method: "POST",
      headers: tenantBHeaders,
      body: JSON.stringify({
        content: "shared isolation token from tenant beta",
        type: "decision",
        project: "tenant-project"
      })
    });

    const tenantAListResponse = await harness.request("/api/list?project=tenant-project&limit=10", {
      headers: tenantAHeaders
    });
    const tenantAList = await readJson<
      Array<{
        content: string;
      }>
    >(tenantAListResponse);
    const tenantARecallResponse = await harness.request("/api/recall", {
      method: "POST",
      headers: tenantAHeaders,
      body: JSON.stringify({
        query: "shared isolation token",
        project: "tenant-project",
        limit: 10,
        min_similarity: 0
      })
    });
    const tenantARecall = await readJson<
      Array<{
        content: string;
      }>
    >(tenantARecallResponse);
    const tenantAStreamResponse = await harness.request(
      "/api/recall/stream?query=shared%20isolation%20token&project=tenant-project&limit=10&min_similarity=0",
      {
        headers: tenantAHeaders
      }
    );
    const tenantAStreamBody = await tenantAStreamResponse.text();

    assert.equal(tenantAListResponse.status, 200);
    assert.equal(tenantAList.length, 1);
    assert.match(tenantAList[0]?.content ?? "", /tenant alpha/);
    assert.equal(tenantAList[0]?.content.includes("tenant beta") ?? false, false);

    assert.equal(tenantARecallResponse.status, 200);
    assert.equal(tenantARecall.length, 1);
    assert.match(tenantARecall[0]?.content ?? "", /tenant alpha/);
    assert.equal(tenantARecall[0]?.content.includes("tenant beta") ?? false, false);

    assert.equal(tenantAStreamResponse.status, 200);
    assert.match(tenantAStreamBody, /tenant alpha/);
    assert.equal(tenantAStreamBody.includes("tenant beta"), false);
  } finally {
    await harness.cleanup();
  }
});

test("tenant-scoped update and delete reject cross-tenant memory access", async () => {
  const harness = await createHarness("top-secret");
  const tenantService = new TenantService(harness.repository);
  const tenantA = tenantService.createTenant("Tenant A", "pro");
  const tenantB = tenantService.createTenant("Tenant B", "pro");
  const tenantAHeaders = {
    authorization: `Bearer ${tenantA.api_key}`
  };
  const tenantBHeaders = {
    authorization: `Bearer ${tenantB.api_key}`
  };

  try {
    const storeResponse = await harness.request("/api/store", {
      method: "POST",
      headers: tenantAHeaders,
      body: JSON.stringify({
        content: "memory owned by tenant alpha",
        type: "insight",
        project: "tenant-project"
      })
    });
    const stored = await readJson<{ id: string }>(storeResponse);

    const patchResponse = await harness.request(`/api/memory/${stored.id}`, {
      method: "PATCH",
      headers: tenantBHeaders,
      body: JSON.stringify({
        content: "tenant beta attempted overwrite"
      })
    });
    const patchBody = await readJson<{ error: string }>(patchResponse);
    const deleteResponse = await harness.request(`/api/memory/${stored.id}`, {
      method: "DELETE",
      headers: tenantBHeaders
    });
    const deleteBody = await readJson<{ error: string }>(deleteResponse);
    const memory = harness.repository.getMemory(stored.id);

    assert.equal(patchResponse.status, 403);
    assert.equal(patchBody.error, "forbidden");
    assert.equal(deleteResponse.status, 403);
    assert.equal(deleteBody.error, "forbidden");
    assert.equal(memory?.content, "memory owned by tenant alpha");
  } finally {
    await harness.cleanup();
  }
});

test("analytics ignores query tenant_id and scopes by authenticated tenant unless using the root key", async () => {
  const harness = await createHarness("top-secret");
  const tenantService = new TenantService(harness.repository);
  const tenantA = tenantService.createTenant("Tenant A", "pro");
  const tenantB = tenantService.createTenant("Tenant B", "pro");
  const tenantAHeaders = {
    authorization: `Bearer ${tenantA.api_key}`
  };
  const tenantBHeaders = {
    authorization: `Bearer ${tenantB.api_key}`
  };

  try {
    await harness.request("/api/store", {
      method: "POST",
      headers: tenantAHeaders,
      body: JSON.stringify({
        content: "analytics memory for tenant alpha",
        type: "decision",
        project: "analytics"
      })
    });
    await harness.request("/api/store", {
      method: "POST",
      headers: tenantBHeaders,
      body: JSON.stringify({
        content: "analytics memory for tenant beta",
        type: "decision",
        project: "analytics"
      })
    });

    const tenantScopedResponse = await harness.request(`/api/analytics?tenant_id=${tenantB.id}`, {
      headers: tenantAHeaders
    });
    const tenantScopedStats = await readJson<{
      memories_total: number;
      memories_by_project: Record<string, number>;
    }>(tenantScopedResponse);
    const rootResponse = await harness.request(`/api/analytics?tenant_id=${tenantA.id}`);
    const rootStats = await readJson<{
      memories_total: number;
      memories_by_project: Record<string, number>;
    }>(rootResponse);

    assert.equal(tenantScopedResponse.status, 200);
    assert.equal(tenantScopedStats.memories_total, 1);
    assert.equal(tenantScopedStats.memories_by_project.analytics, 1);

    assert.equal(rootResponse.status, 200);
    assert.equal(rootStats.memories_total, 2);
    assert.equal(rootStats.memories_by_project.analytics, 2);
  } finally {
    await harness.cleanup();
  }
});

test("dashboard sessions expire on the server after the TTL", async () => {
  const harness = await createHarness("top-secret");
  const sessionToken = "expiring-dashboard-session";
  const originalDateNow = Date.now;

  try {
    Date.now = () => 1_000;
    registerDashboardSession(harness.config, sessionToken);
    assert.equal(hasDashboardSession(harness.config, sessionToken), true);

    Date.now = () => 1_000 + DASHBOARD_SESSION_MAX_AGE_MS + 1;
    assert.equal(hasDashboardSession(harness.config, sessionToken), false);
  } finally {
    Date.now = originalDateNow;
    revokeDashboardSession(harness.config, sessionToken);
    await harness.cleanup();
  }
});

test("pruneStaleSessions removes expired dashboard sessions and keeps active ones", async () => {
  const harness = await createHarness("top-secret");
  const originalDateNow = Date.now;
  const expiredToken = "expired-dashboard-session";
  const activeToken = "active-dashboard-session";

  try {
    Date.now = () => 2_000;
    registerDashboardSession(harness.config, expiredToken);

    Date.now = () => 2_000 + DASHBOARD_SESSION_MAX_AGE_MS;
    registerDashboardSession(harness.config, activeToken);

    Date.now = () => 2_000 + DASHBOARD_SESSION_MAX_AGE_MS + 1;
    pruneStaleSessions(harness.config);

    assert.equal(hasDashboardSession(harness.config, expiredToken), false);
    assert.equal(hasDashboardSession(harness.config, activeToken), true);
  } finally {
    Date.now = originalDateNow;
    revokeDashboardSession(harness.config, expiredToken);
    revokeDashboardSession(harness.config, activeToken);
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
