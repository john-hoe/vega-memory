import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
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
import { ArchiveService } from "../core/archive-service.js";
import { BillingService } from "../core/billing.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { TenantService } from "../core/tenant.js";
import { UserService } from "../core/user.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";
import { PageManager } from "../wiki/page-manager.js";

interface TestHarness {
  baseUrl: string;
  config: VegaConfig;
  repository: Repository;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const createHarness = async (apiKey?: string, overrides: Partial<VegaConfig> = {}): Promise<TestHarness> => {
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
    dbEncryption: false,
    ...overrides
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
      regression_guard: {
        status: string;
        violations: unknown[];
      };
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
    assert.equal(typeof body.regression_guard.status, "string");
    assert.equal(Array.isArray(body.regression_guard.violations), true);
  } finally {
    await harness.cleanup();
  }
});

test("GET /metrics returns Prometheus text when metrics are enabled", async () => {
  const harness = await createHarness(undefined, {
    metricsEnabled: true
  });

  try {
    const response = await fetch(`${harness.baseUrl}/metrics`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /vega_http_requests_total/);
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

test("POST /api/session/start accepts light mode without changing current shape", async () => {
  const harness = await createHarness();
  const workingDirectory = mkdtempSync(join(tmpdir(), "vega-api-session-start-light-"));

  try {
    const response = await harness.request("/api/session/start", {
      method: "POST",
      body: JSON.stringify({
        working_directory: workingDirectory,
        task_hint: "health endpoint",
        mode: "light"
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
    assert.equal(Array.isArray(body.preferences), true);
    assert.equal(typeof body.token_estimate, "number");
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
    await harness.cleanup();
  }
});

test("POST /api/session/start accepts L0 mode and returns only identity preferences", async () => {
  const harness = await createHarness();
  const workingDirectory = mkdtempSync(join(tmpdir(), "vega-api-session-start-l0-"));

  try {
    harness.repository.createMemory({
      id: "pref-api-l0",
      tenant_id: null,
      type: "preference",
      project: "shared",
      title: "Preference",
      content: "Prefer concise summaries.",
      summary: null,
      embedding: null,
      importance: 0.95,
      source: "explicit",
      tags: [],
      created_at: "2026-04-08T00:00:00.000Z",
      updated_at: "2026-04-08T00:00:00.000Z",
      accessed_at: "2026-04-08T00:00:00.000Z",
      status: "active",
      verified: "verified",
      scope: "global",
      accessed_projects: ["vega"]
    });

    const response = await harness.request("/api/session/start", {
      method: "POST",
      body: JSON.stringify({
        working_directory: workingDirectory,
        mode: "L0"
      })
    });
    const body = await readJson<{
      preferences: Array<{ id: string }>;
      active_tasks: unknown[];
      context: unknown[];
      relevant: unknown[];
      conflicts: unknown[];
      deep_recall?: unknown;
    }>(response);

    assert.equal(response.status, 200);
    assert.deepEqual(
      body.preferences.map((memory) => memory.id),
      ["pref-api-l0"]
    );
    assert.deepEqual(body.active_tasks, []);
    assert.deepEqual(body.context, []);
    assert.deepEqual(body.relevant, []);
    assert.deepEqual(body.conflicts, []);
    assert.equal(body.deep_recall, undefined);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
    await harness.cleanup();
  }
});

test("POST /api/session/start returns deep_recall payload for L3", async () => {
  const harness = await createHarness();
  const workingDirectory = mkdtempSync(join(tmpdir(), "vega-api-session-start-l3-"));
  const project = basename(workingDirectory);
  const archiveService = new ArchiveService(harness.repository);

  try {
    harness.repository.createMemory({
      id: "memory-api-l3",
      tenant_id: null,
      type: "decision",
      project,
      title: "Backup validation",
      content: "Hot summary for backup validation.",
      summary: null,
      embedding: null,
      importance: 0.8,
      source: "explicit",
      tags: ["backup"],
      created_at: "2026-04-08T00:00:00.000Z",
      updated_at: "2026-04-08T00:00:00.000Z",
      accessed_at: "2026-04-08T00:00:00.000Z",
      status: "active",
      verified: "verified",
      scope: "project",
      accessed_projects: [project]
    });
    archiveService.store(
      "Full tool log with backup evidence and restore commands.",
      "tool_log",
      project,
      {
        source_memory_id: "memory-api-l3",
        title: "Backup tool log"
      }
    );

    const response = await harness.request("/api/session/start", {
      method: "POST",
      body: JSON.stringify({
        working_directory: workingDirectory,
        task_hint: "backup evidence",
        mode: "L3"
      })
    });
    const body = await readJson<{
      deep_recall?: {
        injected_into_session: boolean;
        results: Array<{ archive_type: string; content?: string }>;
      };
    }>(response);

    assert.equal(response.status, 200);
    assert.ok(body.deep_recall);
    assert.equal(body.deep_recall.injected_into_session, true);
    assert.equal(body.deep_recall.results.length, 1);
    assert.equal(body.deep_recall.results[0]?.archive_type, "tool_log");
    assert.match(body.deep_recall.results[0]?.content ?? "", /restore commands/);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
    await harness.cleanup();
  }
});

test("POST /api/deep-recall returns archive-backed evidence", async () => {
  const harness = await createHarness();

  try {
    const storeResponse = await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "SQLite backup evidence lives in the cold archive tier.",
        type: "decision",
        project: "vega"
      })
    });
    const stored = await readJson<{ id: string }>(storeResponse);
    const response = await harness.request("/api/deep-recall", {
      method: "POST",
      body: JSON.stringify({
        query: "sqlite backup evidence",
        project: "vega",
        include_content: true
      })
    });
    const body = await readJson<{
      results: Array<{
        archive_id: string;
        memory_id: string | null;
        archive_type: string;
        content?: string;
      }>;
      next_cursor: string | null;
      injected_into_session: boolean;
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.next_cursor, null);
    assert.equal(body.injected_into_session, false);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0]?.memory_id, stored.id);
    assert.equal(body.results[0]?.archive_type, "document");
    assert.match(body.results[0]?.content ?? "", /cold archive tier/);
  } finally {
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

test("tenant-scoped session APIs only expose and update the current tenant's memories", async () => {
  const harness = await createHarness("top-secret");
  const tenantService = new TenantService(harness.repository);
  const tenantA = tenantService.createTenant("Tenant A", "pro");
  const tenantB = tenantService.createTenant("Tenant B", "pro");
  const tenantAHeaders = {
    authorization: `Bearer ${tenantA.api_key}`
  };
  const workingDirectory = mkdtempSync(join(tmpdir(), "vega-api-session-tenant-"));
  const project = basename(workingDirectory);

  try {
    harness.repository.createMemory({
      id: "tenant-a-context",
      tenant_id: tenantA.id,
      type: "project_context",
      project,
      title: "Tenant A context",
      content: "Tenant A project context",
      summary: null,
      embedding: null,
      importance: 0.5,
      source: "auto",
      tags: [],
      created_at: "2026-04-08T00:00:00.000Z",
      updated_at: "2026-04-08T00:00:00.000Z",
      accessed_at: "2026-04-08T00:00:00.000Z",
      status: "active",
      verified: "unverified",
      scope: "project",
      accessed_projects: [project]
    });
    harness.repository.createMemory({
      id: "tenant-b-context",
      tenant_id: tenantB.id,
      type: "project_context",
      project,
      title: "Tenant B context",
      content: "Tenant B project context",
      summary: null,
      embedding: null,
      importance: 0.5,
      source: "auto",
      tags: [],
      created_at: "2026-04-08T00:00:00.000Z",
      updated_at: "2026-04-08T00:00:00.000Z",
      accessed_at: "2026-04-08T00:00:00.000Z",
      status: "active",
      verified: "unverified",
      scope: "project",
      accessed_projects: [project]
    });
    harness.repository.createMemory({
      id: "tenant-a-task",
      tenant_id: tenantA.id,
      type: "task_state",
      project: "vega",
      title: "Tenant A task",
      content: "Tenant A task",
      summary: null,
      embedding: null,
      importance: 0.9,
      source: "auto",
      tags: [],
      created_at: "2026-04-08T00:00:00.000Z",
      updated_at: "2026-04-08T00:00:00.000Z",
      accessed_at: "2026-04-08T00:00:00.000Z",
      status: "active",
      verified: "unverified",
      scope: "project",
      accessed_projects: ["vega"]
    });

    const startResponse = await harness.request("/api/session/start", {
      method: "POST",
      headers: tenantAHeaders,
      body: JSON.stringify({
        working_directory: workingDirectory
      })
    });
    const startBody = await readJson<{
      context: Array<{ id: string }>;
    }>(startResponse);
    const endResponse = await harness.request("/api/session/end", {
      method: "POST",
      headers: tenantAHeaders,
      body: JSON.stringify({
        project: "vega",
        summary: "Session completed.",
        completed_tasks: ["tenant-a-task", "tenant-b-context"]
      })
    });
    const endBody = await readJson<{ error: string }>(endResponse);
    const task = harness.repository.getMemory("tenant-a-task");

    assert.equal(startResponse.status, 200);
    assert.deepEqual(
      startBody.context.map((memory) => memory.id),
      ["tenant-a-context"]
    );
    assert.equal(endResponse.status, 403);
    assert.equal(endBody.error, "forbidden");
    assert.equal(task?.importance, 0.9);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
    await harness.cleanup();
  }
});

test("tenant bearer keys cannot access admin routes but the root API key can", async () => {
  const harness = await createHarness("top-secret");
  const tenantService = new TenantService(harness.repository);
  const tenant = tenantService.createTenant("Tenant A", "pro");

  try {
    const tenantResponse = await harness.request("/api/admin/dashboard", {
      headers: {
        authorization: `Bearer ${tenant.api_key}`
      }
    });
    const tenantBody = await readJson<{ error: string }>(tenantResponse);
    const rootResponse = await harness.request("/api/admin/dashboard");

    assert.equal(tenantResponse.status, 403);
    assert.equal(tenantBody.error, "forbidden");
    assert.equal(rootResponse.status, 200);
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

test("tenant-scoped compact only archives the current tenant's memories", async () => {
  const harness = await createHarness();
  const tenantService = new TenantService(harness.repository);
  const userService = new UserService(harness.repository);
  const tenantA = tenantService.createTenant("Tenant A", "pro");
  const tenantB = tenantService.createTenant("Tenant B", "pro");
  const adminUser = userService.createUser(
    "tenant-a-admin@example.com",
    "Tenant A Admin",
    "admin",
    tenantA.id
  );
  const sessionToken = "tenant-a-compact-admin";

  registerDashboardSession(harness.config, sessionToken, adminUser);

  try {
    harness.repository.createMemory({
      id: "tenant-a-low-priority",
      tenant_id: tenantA.id,
      type: "insight",
      project: "tenant-project",
      title: "Tenant A low priority",
      content: "Archive only tenant A",
      summary: null,
      embedding: null,
      importance: 0.05,
      source: "auto",
      tags: [],
      created_at: "2026-04-08T00:00:00.000Z",
      updated_at: "2026-04-08T00:00:00.000Z",
      accessed_at: "2026-04-08T00:00:00.000Z",
      status: "active",
      verified: "unverified",
      scope: "project",
      accessed_projects: ["tenant-project"]
    });
    harness.repository.createMemory({
      id: "tenant-b-low-priority",
      tenant_id: tenantB.id,
      type: "insight",
      project: "tenant-project",
      title: "Tenant B low priority",
      content: "Do not archive tenant B",
      summary: null,
      embedding: null,
      importance: 0.05,
      source: "auto",
      tags: [],
      created_at: "2026-04-08T00:00:00.000Z",
      updated_at: "2026-04-08T00:00:00.000Z",
      accessed_at: "2026-04-08T00:00:00.000Z",
      status: "active",
      verified: "unverified",
      scope: "project",
      accessed_projects: ["tenant-project"]
    });

    const response = await harness.request("/api/compact", {
      method: "POST",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE}=${sessionToken}`
      },
      body: JSON.stringify({
        project: "tenant-project"
      })
    });
    const body = await readJson<{ archived: number }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.archived, 1);
    assert.equal(harness.repository.getMemory("tenant-a-low-priority")?.status, "archived");
    assert.equal(harness.repository.getMemory("tenant-b-low-priority")?.status, "active");
  } finally {
    revokeDashboardSession(harness.config, sessionToken);
    await harness.cleanup();
  }
});

test("tenant-scoped audit purge only deletes the current tenant's entries", async () => {
  const harness = await createHarness();
  const tenantService = new TenantService(harness.repository);
  const userService = new UserService(harness.repository);
  const tenantA = tenantService.createTenant("Tenant A", "pro");
  const tenantB = tenantService.createTenant("Tenant B", "pro");
  const adminUser = userService.createUser(
    "tenant-a-audit@example.com",
    "Tenant A Audit",
    "admin",
    tenantA.id
  );
  const sessionToken = "tenant-a-audit-admin";

  registerDashboardSession(harness.config, sessionToken, adminUser);

  try {
    harness.repository.logAudit({
      timestamp: "2026-04-01T00:00:00.000Z",
      actor: "alice",
      action: "tenant-a-event",
      memory_id: null,
      detail: "tenant a old entry",
      ip: null,
      tenant_id: tenantA.id
    });
    harness.repository.logAudit({
      timestamp: "2026-04-01T00:00:00.000Z",
      actor: "bob",
      action: "tenant-b-event",
      memory_id: null,
      detail: "tenant b old entry",
      ip: null,
      tenant_id: tenantB.id
    });

    const response = await harness.request("/api/admin/audit/purge?before=2026-04-02T00:00:00.000Z", {
      method: "DELETE",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE}=${sessionToken}`
      }
    });
    const body = await readJson<{ deleted: number }>(response);
    const remaining = harness.repository.getAuditLog();

    assert.equal(response.status, 200);
    assert.equal(body.deleted, 1);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.tenant_id, tenantB.id);
  } finally {
    revokeDashboardSession(harness.config, sessionToken);
    await harness.cleanup();
  }
});

test("tenant wiki list, versions, read, and search routes do not leak cross-tenant pages", async () => {
  const harness = await createHarness("top-secret");
  const tenantService = new TenantService(harness.repository);
  const tenantA = tenantService.createTenant("Tenant A", "pro");
  const tenantB = tenantService.createTenant("Tenant B", "pro");
  const pageManager = new PageManager(harness.repository);
  const tenantAHeaders = {
    authorization: `Bearer ${tenantA.api_key}`
  };

  try {
    const tenantAPage = pageManager.createPage({
      title: "Tenant A Guide",
      content: "shared wiki isolation token alpha",
      summary: "alpha summary",
      page_type: "reference",
      project: "wiki-tenant",
      tenant_id: tenantA.id
    });
    const tenantBPage = pageManager.createPage({
      title: "Tenant B Guide",
      content: "shared wiki isolation token beta",
      summary: "beta summary",
      page_type: "reference",
      project: "wiki-tenant",
      tenant_id: tenantB.id
    });

    pageManager.updatePage(
      tenantAPage.id,
      {
        content: "shared wiki isolation token alpha v2"
      },
      "Create a prior version"
    );
    pageManager.updatePage(
      tenantBPage.id,
      {
        content: "shared wiki isolation token beta v2"
      },
      "Create a prior version"
    );

    const listResponse = await harness.request("/api/wiki/pages?project=wiki-tenant&limit=10", {
      headers: tenantAHeaders
    });
    const listed = await readJson<Array<{ slug: string }>>(listResponse);
    const versionsResponse = await harness.request(`/api/wiki/pages/${tenantBPage.slug}/versions`, {
      headers: tenantAHeaders
    });
    const versionsBody = await readJson<{ error: string }>(versionsResponse);
    const readResponse = await harness.request(`/api/wiki/pages/${tenantBPage.slug}`, {
      headers: tenantAHeaders
    });
    const readBody = await readJson<{ error: string }>(readResponse);
    const searchResponse = await harness.request("/api/wiki/search", {
      method: "POST",
      headers: tenantAHeaders,
      body: JSON.stringify({
        query: "shared wiki isolation token",
        project: "wiki-tenant",
        limit: 10
      })
    });
    const searched = await readJson<Array<{ slug: string }>>(searchResponse);

    assert.equal(listResponse.status, 200);
    assert.deepEqual(listed.map((page) => page.slug), [tenantAPage.slug]);

    assert.equal(versionsResponse.status, 404);
    assert.equal(versionsBody.error, `Wiki page not found: ${tenantBPage.slug}`);

    assert.equal(readResponse.status, 404);
    assert.equal(readBody.error, `Wiki page not found: ${tenantBPage.slug}`);

    assert.equal(searchResponse.status, 200);
    assert.deepEqual(searched.map((page) => page.slug), [tenantAPage.slug]);
  } finally {
    await harness.cleanup();
  }
});

test("webhook routes require admin access when auth is enabled", async () => {
  const harness = await createHarness("top-secret");
  const tenantService = new TenantService(harness.repository);
  const tenant = tenantService.createTenant("Tenant A", "pro");
  const tenantHeaders = {
    authorization: `Bearer ${tenant.api_key}`
  };

  try {
    const createResponse = await harness.request("/api/webhooks", {
      method: "POST",
      headers: tenantHeaders,
      body: JSON.stringify({
        url: "https://tenant.example/webhooks/memory",
        events: ["memory.created"],
        enabled: true
      })
    });
    const createBody = await readJson<{ error: string }>(createResponse);
    const listResponse = await harness.request("/api/webhooks", {
      headers: tenantHeaders
    });
    const listBody = await readJson<{ error: string }>(listResponse);
    const deleteResponse = await harness.request(
      `/api/webhooks/${encodeURIComponent("https://tenant.example/webhooks/memory")}`,
      {
        method: "DELETE",
        headers: tenantHeaders
      }
    );
    const deleteBody = await readJson<{ error: string }>(deleteResponse);
    const testResponse = await harness.request("/api/webhooks/test", {
      method: "POST",
      headers: tenantHeaders,
      body: JSON.stringify({
        event: "memory.created",
        data: {
          id: "memory-1"
        }
      })
    });
    const testBody = await readJson<{ error: string }>(testResponse);
    const rootCreateResponse = await harness.request("/api/webhooks", {
      method: "POST",
      body: JSON.stringify({
        url: "https://root.example/webhooks/memory",
        events: ["memory.created"],
        enabled: true
      })
    });

    assert.equal(createResponse.status, 403);
    assert.equal(createBody.error, "forbidden");
    assert.equal(listResponse.status, 403);
    assert.equal(listBody.error, "forbidden");
    assert.equal(deleteResponse.status, 403);
    assert.equal(deleteBody.error, "forbidden");
    assert.equal(testResponse.status, 403);
    assert.equal(testBody.error, "forbidden");
    assert.equal(rootCreateResponse.status, 201);
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

test("billing routes expose plans, tenant subscription status, cancellation, and signed webhook handling", async () => {
  const harness = await createHarness("top-secret", {
    stripeEnabled: true,
    stripeSecretKey: "sk_test_stub",
    stripeWebhookSecret: "whsec_stub"
  });
  const tenantService = new TenantService(harness.repository);
  const tenant = tenantService.createTenant("Billing Tenant", "pro");
  const userService = new UserService(harness.repository);
  const user = userService.createUser("billing@example.com", "Billing User", "member", tenant.id);
  const sessionToken = "billing-dashboard-session";

  registerDashboardSession(harness.config, sessionToken, user);

  try {
    const plansResponse = await harness.request("/api/billing/plans");
    const plans = await readJson<Array<{ id: string }>>(plansResponse);
    const subscribeResponse = await fetch(`${harness.baseUrl}/api/billing/subscribe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${DASHBOARD_AUTH_COOKIE}=${sessionToken}`
      },
      body: JSON.stringify({
        plan_id: "pro"
      })
    });
    const subscribed = await readJson<{
      customer: { id: string; tenantId: string };
      subscription: { id: string; status: string };
    }>(subscribeResponse);
    const statusResponse = await fetch(`${harness.baseUrl}/api/billing/status`, {
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE}=${sessionToken}`
      }
    });
    const statusBody = await readJson<{
      tenant_id: string;
      configured: boolean;
      subscription: { id: string; status: string } | null;
    }>(statusResponse);
    const cancelResponse = await fetch(
      `${harness.baseUrl}/api/billing/subscribe/${subscribed.subscription.id}`,
      {
        method: "DELETE",
        headers: {
          cookie: `${DASHBOARD_AUTH_COOKIE}=${sessionToken}`
        }
      }
    );
    const canceled = await readJson<{ id: string; status: string }>(cancelResponse);
    const webhookPayload = JSON.stringify({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subscribed.subscription.id
        }
      }
    });
    const webhookSignature = createHmac("sha256", "whsec_stub")
      .update(webhookPayload)
      .digest("hex");
    const webhookResponse = await fetch(`${harness.baseUrl}/api/billing/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": webhookSignature
      },
      body: webhookPayload
    });
    const webhookBody = await readJson<{
      event: string;
      data: { object: { id: string } };
    }>(webhookResponse);

    assert.equal(plansResponse.status, 200);
    assert.equal(plans.length, 3);
    assert.deepEqual(
      plans.map((plan) => plan.id),
      ["free", "pro", "enterprise"]
    );

    assert.equal(subscribeResponse.status, 201);
    assert.match(subscribed.customer.id, /^cus_stub_/);
    assert.equal(subscribed.customer.tenantId, tenant.id);
    assert.match(subscribed.subscription.id, /^sub_stub_/);
    assert.equal(subscribed.subscription.status, "active");

    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.tenant_id, tenant.id);
    assert.equal(statusBody.configured, true);
    assert.equal(statusBody.subscription?.id, subscribed.subscription.id);

    assert.equal(cancelResponse.status, 200);
    assert.equal(canceled.id, subscribed.subscription.id);
    assert.equal(canceled.status, "canceled");

    assert.equal(webhookResponse.status, 200);
    assert.equal(webhookBody.event, "customer.subscription.updated");
    assert.equal(webhookBody.data.object.id, subscribed.subscription.id);
  } finally {
    revokeDashboardSession(harness.config, sessionToken);
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

test("analytics forbids tenant bearer auth and root API key still returns global stats", async () => {
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
    const tenantScopedBody = await readJson<{ error: string }>(tenantScopedResponse);
    const rootResponse = await harness.request(`/api/analytics?tenant_id=${tenantA.id}`);
    const rootStats = await readJson<{
      memories_total: number;
      memories_by_project: Record<string, number>;
    }>(rootResponse);

    assert.equal(tenantScopedResponse.status, 403);
    assert.equal(tenantScopedBody.error, "forbidden");

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
