import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  DASHBOARD_AUTH_COOKIE,
  registerDashboardSession,
  revokeDashboardSession
} from "../api/auth.js";
import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { AuditService } from "../core/audit-service.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { TenantService } from "../core/tenant.js";
import { UserService, type User } from "../core/user.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";

interface TestHarness {
  baseUrl: string;
  config: VegaConfig;
  repository: Repository;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const createHarness = async (): Promise<TestHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-audit-api-"));
  const config: VegaConfig = {
    dbPath: join(tempDir, "memory.db"),
    ollamaBaseUrl: "http://localhost:99999",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    shardingEnabled: false,
    backupRetentionDays: 7,
    apiPort: 0,
    apiKey: undefined,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(tempDir, "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    observerEnabled: false,
    dbEncryption: false,
    customRedactionPatterns: []
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
    baseUrl: `http://127.0.0.1:${port}`,
    config,
    repository,
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

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const createSessionUser = (
  tenantId: string,
  role: User["role"],
  id: string
): User => ({
  id,
  email: `${id}@example.com`,
  name: id,
  role,
  tenant_id: tenantId,
  created_at: "2026-04-07T00:00:00.000Z"
});

test("AuditService logs, queries with filters, and purges old entries", () => {
  const repository = new Repository(":memory:");
  const service = new AuditService(repository);

  try {
    service.log("login", "alice", "Admin logged in", {
      ip: "127.0.0.1",
      tenantId: "tenant-a"
    });
    repository.logAudit({
      timestamp: "2026-04-01T00:00:00.000Z",
      actor: "alice",
      action: "store_created",
      memory_id: "memory-1",
      detail: "Created memory-1",
      ip: "10.0.0.1",
      tenant_id: "tenant-a"
    });
    repository.logAudit({
      timestamp: "2026-04-02T00:00:00.000Z",
      actor: "bob",
      action: "store_updated",
      memory_id: "memory-2",
      detail: "Updated memory-2",
      ip: "10.0.0.2",
      tenant_id: "tenant-b"
    });
    repository.logAudit({
      timestamp: "2026-04-03T00:00:00.000Z",
      actor: "alice",
      action: "store_updated",
      memory_id: "memory-1",
      detail: "Updated memory-1",
      ip: "10.0.0.3",
      tenant_id: "tenant-a"
    });

    assert.equal(service.count(), 4);
    assert.equal(service.query({ actor: "alice" }).length, 3);
    assert.equal(service.query({ action: "store_updated" }).length, 2);
    assert.equal(service.query({ memoryId: "memory-1" }).length, 2);
    assert.equal(
      service.query({
        since: "2026-04-02T00:00:00.000Z",
        until: "2026-04-03T23:59:59.999Z"
      }).length,
      2
    );
    assert.equal(service.query({ tenantId: "tenant-a" }).length, 3);
    assert.equal(service.query({ limit: 1, offset: 1 }).length, 1);
    assert.deepEqual(service.getActions(), ["login", "store_created", "store_updated"]);
    assert.deepEqual(service.getActors("tenant-a"), ["alice"]);

    const deleted = service.purge(new Date("2026-04-02T12:00:00.000Z"));

    assert.equal(deleted, 2);
    assert.equal(service.count(), 2);
  } finally {
    repository.close();
  }
});

test("admin audit and user routes require an admin dashboard session", async () => {
  const harness = await createHarness();
  const tenantService = new TenantService(harness.repository);
  const userService = new UserService(harness.repository);
  const auditService = new AuditService(harness.repository);
  const tenant = tenantService.createTenant("Acme", "pro");
  const targetUser = userService.createUser("target@example.com", "Target", "viewer", tenant.id);
  const adminToken = "audit-admin-session";
  const memberToken = "audit-member-session";
  const adminUser = createSessionUser(tenant.id, "admin", "admin-user");
  const memberUser = createSessionUser(tenant.id, "member", "member-user");

  registerDashboardSession(harness.config, adminToken, adminUser);
  registerDashboardSession(harness.config, memberToken, memberUser);

  try {
    auditService.log("store_created", "api", "Created memory from admin test", {
      memoryId: "memory-admin",
      tenantId: tenant.id
    });
    harness.repository.logPerformance({
      timestamp: "2026-04-08T00:00:00.000Z",
      tenant_id: tenant.id,
      operation: "tenant-dashboard",
      latency_ms: 12,
      memory_count: 1,
      result_count: 1,
      avg_similarity: 0.9,
      result_types: ["decision"],
      bm25_result_count: 1
    });
    harness.repository.logPerformance({
      timestamp: "2026-04-08T00:00:01.000Z",
      tenant_id: "other-tenant",
      operation: "other-dashboard",
      latency_ms: 18,
      memory_count: 1,
      result_count: 1,
      avg_similarity: 0.7,
      result_types: ["insight"],
      bm25_result_count: 1
    });

    const memberHeaders = {
      cookie: `${DASHBOARD_AUTH_COOKIE}=${memberToken}`
    };

    for (const [path, init] of [
      ["/api/admin/audit", undefined],
      ["/api/admin/audit/stats", undefined],
      ["/api/admin/audit/purge?before=2026-04-08T00:00:00.000Z", { method: "DELETE" }],
      ["/api/admin/users", undefined],
      [
        `/api/admin/users/${targetUser.id}/role`,
        {
          method: "PATCH",
          body: JSON.stringify({
            role: "member"
          })
        }
      ],
      ["/api/admin/dashboard", undefined]
    ] as const) {
      const response = await harness.request(path, {
        ...init,
        headers: memberHeaders
      });

      assert.equal(response.status, 403);
    }

    const adminHeaders = {
      cookie: `${DASHBOARD_AUTH_COOKIE}=${adminToken}`
    };

    const auditResponse = await harness.request("/api/admin/audit", {
      headers: adminHeaders
    });
    const auditBody = await readJson<{
      total: number;
      entries: Array<{ action: string; tenant_id: string | null }>;
    }>(auditResponse);
    const statsResponse = await harness.request("/api/admin/audit/stats", {
      headers: adminHeaders
    });
    const statsBody = await readJson<{
      total: number;
      by_action: Record<string, number>;
      by_actor: Record<string, number>;
    }>(statsResponse);
    const usersResponse = await harness.request("/api/admin/users", {
      headers: adminHeaders
    });
    const usersBody = await readJson<Array<{ id: string }>>(usersResponse);
    const roleResponse = await harness.request(`/api/admin/users/${targetUser.id}/role`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({
        role: "member"
      })
    });
    const roleBody = await readJson<{ id: string; role: string }>(roleResponse);
    const dashboardResponse = await harness.request("/api/admin/dashboard", {
      headers: adminHeaders
    });
    const dashboardBody = await readJson<{
      total_users: number;
      total_memories: number;
      active_tenants: number;
      recent_activity: Array<{ operation: string; tenant_id: string | null }>;
      recent_audit_events: Array<{ action: string }>;
    }>(dashboardResponse);
    const purgeResponse = await harness.request(
      "/api/admin/audit/purge?before=2099-01-01T00:00:00.000Z",
      {
        method: "DELETE",
        headers: adminHeaders
      }
    );
    const purgeBody = await readJson<{ deleted: number }>(purgeResponse);

    assert.equal(auditResponse.status, 200);
    assert.equal(auditBody.total, 1);
    assert.equal(auditBody.entries[0]?.action, "store_created");
    assert.equal(auditBody.entries[0]?.tenant_id, tenant.id);

    assert.equal(statsResponse.status, 200);
    assert.equal(statsBody.total, 1);
    assert.equal(statsBody.by_action.store_created, 1);
    assert.equal(statsBody.by_actor.api, 1);

    assert.equal(usersResponse.status, 200);
    assert.equal(usersBody.some((user) => user.id === targetUser.id), true);

    assert.equal(roleResponse.status, 200);
    assert.equal(roleBody.id, targetUser.id);
    assert.equal(roleBody.role, "member");

    assert.equal(dashboardResponse.status, 200);
    assert.equal(dashboardBody.total_users, 1);
    assert.equal(dashboardBody.active_tenants, 1);
    assert.equal(
      dashboardBody.recent_activity.some((entry) => entry.operation === "other-dashboard"),
      false
    );
    assert.equal(
      dashboardBody.recent_activity.length > 0,
      true
    );
    assert.equal(
      dashboardBody.recent_activity.every((entry) => entry.tenant_id === tenant.id),
      true
    );
    assert.equal(dashboardBody.recent_audit_events[0]?.action, "store_created");

    assert.equal(purgeResponse.status, 200);
    assert.equal(purgeBody.deleted, 1);
    assert.equal(auditService.count({ tenantId: tenant.id }), 0);
  } finally {
    revokeDashboardSession(harness.config, adminToken);
    revokeDashboardSession(harness.config, memberToken);
    await harness.cleanup();
  }
});
