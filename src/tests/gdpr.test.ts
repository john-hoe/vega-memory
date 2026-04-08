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
import { GdprService } from "../compliance/gdpr.js";
import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { SessionService } from "../core/session.js";
import { TeamService } from "../core/team.js";
import { TenantService } from "../core/tenant.js";
import type { Memory, Session } from "../core/types.js";
import { UserService, type User } from "../core/user.js";
import { Repository } from "../db/repository.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SearchEngine } from "../search/engine.js";
import { PageManager } from "../wiki/page-manager.js";

interface TestHarness {
  baseUrl: string;
  config: VegaConfig;
  repository: Repository;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const timestamp = "2026-04-08T10:00:00.000Z";

const createStoredMemory = (
  id: string,
  tenantId: string,
  overrides: Partial<Memory> = {}
): Memory => {
  const { summary = null, ...rest } = overrides;

  return {
    id,
    tenant_id: tenantId,
    type: "decision",
    project: "vega",
    title: `Memory ${id}`,
    content: `Content for ${id}`,
    embedding: null,
    importance: 0.7,
    source: "explicit",
    tags: ["gdpr"],
    created_at: timestamp,
    updated_at: timestamp,
    accessed_at: timestamp,
    access_count: 0,
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega"],
    ...rest,
    summary
  };
};

const createStoredSession = (id: string, memoryId: string): Session => ({
  id,
  project: "vega",
  summary: `Session ${id}`,
  started_at: timestamp,
  ended_at: "2026-04-08T11:00:00.000Z",
  memories_created: [memoryId]
});

const createSessionUser = (tenantId: string, role: User["role"], id: string): User => ({
  id,
  email: `${id}@example.com`,
  name: id,
  role,
  tenant_id: tenantId,
  created_at: timestamp
});

const addOwnershipColumns = (repository: Repository): void => {
  repository.db.exec(`
    ALTER TABLE memories ADD COLUMN user_id TEXT;
    ALTER TABLE sessions ADD COLUMN user_id TEXT;
    ALTER TABLE wiki_pages ADD COLUMN user_id TEXT;
  `);
};

const seedSubjectData = (
  repository: Repository,
  tenantId: string,
  userId: string,
  suffix = "subject"
): {
  memoryId: string;
  sessionId: string;
  pageId: string;
  teamId: string;
} => {
  const memoryId = `memory-${suffix}`;
  const sessionId = `session-${suffix}`;
  const memory = createStoredMemory(memoryId, tenantId, {
    title: `Privacy Memory ${suffix}`,
    content: `PII for ${userId}`,
    tags: ["gdpr", suffix]
  });
  repository.createMemory(memory);
  repository.db.run("UPDATE memories SET user_id = ? WHERE id = ?", userId, memoryId);

  repository.createSession(createStoredSession(sessionId, memoryId));
  repository.db.run("UPDATE sessions SET user_id = ? WHERE id = ?", userId, sessionId);

  const pageManager = new PageManager(repository);
  const page = pageManager.createPage({
    title: `Privacy Page ${suffix}`,
    content: `Wiki content for ${userId}`,
    summary: `Summary for ${userId}`,
    page_type: "reference",
    project: "vega",
    tags: ["gdpr", suffix],
    tenant_id: tenantId
  });
  repository.db.run("UPDATE wiki_pages SET user_id = ? WHERE id = ?", userId, page.id);

  repository.logAudit({
    timestamp,
    actor: userId,
    action: "store_created",
    memory_id: memoryId,
    detail: `Created privacy record for ${userId}`,
    ip: "10.0.0.1",
    tenant_id: tenantId
  });

  const teamService = new TeamService(repository);
  const team = teamService.createTeam(`Team ${suffix}`, userId);

  return {
    memoryId,
    sessionId,
    pageId: page.id,
    teamId: team.id
  };
};

const createApiHarness = async (): Promise<TestHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-gdpr-api-"));
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

test("GdprService exports all requested sections, categories, and DPA articles", async () => {
  const repository = new Repository(":memory:");
  const tenantService = new TenantService(repository);
  const userService = new UserService(repository);
  addOwnershipColumns(repository);

  try {
    const tenant = tenantService.createTenant("Acme", "pro");
    const user = userService.createUser("alice@example.com", "Alice", "viewer", tenant.id);
    seedSubjectData(repository, tenant.id, user.id);
    const service = new GdprService(repository.db);

    const exported = await service.exportUserData(user.id, tenant.id);
    const categories = await service.getDataCategories();
    const dpa = await service.generateDPA(tenant.id);

    assert.equal(exported.userId, user.id);
    assert.equal(exported.sections.users.length, 1);
    assert.equal(exported.sections.memories.length, 1);
    assert.equal(exported.sections.sessions.length, 1);
    assert.equal(exported.sections.wiki_pages.length, 1);
    assert.equal(exported.sections.audit_log.length, 1);
    assert.equal(exported.sections.team_members.length, 1);
    assert.equal(exported.sections.teams.length, 1);
    assert.deepEqual(
      (exported.sections.memories[0] as { tags: string[] }).tags,
      ["gdpr", "subject"]
    );
    assert.deepEqual(
      (exported.sections.sessions[0] as { memories_created: string[] }).memories_created,
      ["memory-subject"]
    );
    assert.deepEqual(
      categories.map((category) => category.name),
      ["memories", "sessions", "wiki", "audit"]
    );
    assert.match(dpa, /Article 28/);
    assert.match(dpa, /Article 32/);
    assert.match(dpa, /Article 33/);
    assert.match(dpa, /Article 15/);
    assert.match(dpa, /Article 17/);
  } finally {
    repository.close();
  }
});

test("GdprService erases matching rows and anonymizes retained records", async () => {
  const repository = new Repository(":memory:");
  const tenantService = new TenantService(repository);
  const userService = new UserService(repository);
  addOwnershipColumns(repository);

  try {
    const tenant = tenantService.createTenant("Acme", "pro");
    const subjectUser = userService.createUser("alice@example.com", "Alice", "viewer", tenant.id);
    const otherUser = userService.createUser("bob@example.com", "Bob", "viewer", tenant.id);
    const subjectIds = seedSubjectData(repository, tenant.id, subjectUser.id, "subject");
    const otherIds = seedSubjectData(repository, tenant.id, otherUser.id, "other");
    const service = new GdprService(repository.db);

    const report = await service.eraseUserData(subjectUser.id, tenant.id);

    assert.equal(report.erasedCounts.users, 1);
    assert.equal(report.erasedCounts.memories, 1);
    assert.equal(report.erasedCounts.sessions, 1);
    assert.equal(report.erasedCounts.wiki_pages, 1);
    assert.equal(report.erasedCounts.team_members, 1);
    assert.equal(report.erasedCounts.teams, 1);
    assert.equal(report.erasedCounts.audit_log, 1);
    assert.deepEqual(report.anonymized.sort(), ["audit_log", "teams"]);
    assert.equal(repository.getUser(subjectUser.id), null);
    assert.equal(repository.getUser(otherUser.id)?.id, otherUser.id);
    assert.equal(
      repository.db.get<{ total: number }>("SELECT COUNT(*) AS total FROM memories WHERE id = ?", subjectIds.memoryId)
        ?.total,
      0
    );
    assert.equal(
      repository.db.get<{ total: number }>("SELECT COUNT(*) AS total FROM memories WHERE id = ?", otherIds.memoryId)
        ?.total,
      1
    );
    assert.equal(
      repository.db.get<{ total: number }>("SELECT COUNT(*) AS total FROM sessions WHERE id = ?", subjectIds.sessionId)
        ?.total,
      0
    );
    assert.equal(
      repository.db.get<{ total: number }>("SELECT COUNT(*) AS total FROM wiki_pages WHERE id = ?", subjectIds.pageId)
        ?.total,
      0
    );
    assert.equal(
      repository.db.get<{ total: number }>(
        "SELECT COUNT(*) AS total FROM team_members WHERE team_id = ? AND user_id = ?",
        subjectIds.teamId,
        subjectUser.id
      )?.total,
      0
    );
    assert.equal(
      repository.db.get<{ owner_id: string }>("SELECT owner_id FROM teams WHERE id = ?", subjectIds.teamId)
        ?.owner_id,
      "deleted-user"
    );
    assert.equal(
      repository.db.get<{ owner_id: string }>("SELECT owner_id FROM teams WHERE id = ?", otherIds.teamId)
        ?.owner_id,
      otherUser.id
    );
    assert.deepEqual(
      repository.db.get<{ actor: string; detail: string; ip: string | null }>(
        "SELECT actor, detail, ip FROM audit_log WHERE memory_id = ? AND actor = 'deleted-user'",
        subjectIds.memoryId
      ),
      {
        actor: "deleted-user",
        detail: "Erased under GDPR Article 17 request",
        ip: null
      }
    );
  } finally {
    repository.close();
  }
});

test("GDPR API routes require admin access and execute export and erase", async () => {
  const harness = await createApiHarness();
  const tenantService = new TenantService(harness.repository);
  const userService = new UserService(harness.repository);
  addOwnershipColumns(harness.repository);
  const tenant = tenantService.createTenant("Acme", "pro");
  const targetUser = userService.createUser("target@example.com", "Target", "viewer", tenant.id);
  const memberToken = "gdpr-member-session";
  const adminToken = "gdpr-admin-session";
  seedSubjectData(harness.repository, tenant.id, targetUser.id);

  registerDashboardSession(harness.config, memberToken, createSessionUser(tenant.id, "member", "member-user"));
  registerDashboardSession(harness.config, adminToken, createSessionUser(tenant.id, "admin", "admin-user"));

  try {
    const memberHeaders = {
      cookie: `${DASHBOARD_AUTH_COOKIE}=${memberToken}`
    };
    const adminHeaders = {
      cookie: `${DASHBOARD_AUTH_COOKIE}=${adminToken}`
    };

    const forbiddenExport = await harness.request(`/api/gdpr/export/${targetUser.id}`, {
      headers: memberHeaders
    });
    const forbiddenErase = await harness.request(`/api/gdpr/erase/${targetUser.id}`, {
      method: "POST",
      headers: memberHeaders
    });

    assert.equal(forbiddenExport.status, 403);
    assert.equal(forbiddenErase.status, 403);

    const exportResponse = await harness.request(`/api/gdpr/export/${targetUser.id}`, {
      headers: adminHeaders
    });
    const exportBody = await readJson<UserDataExportPayload>(exportResponse);

    assert.equal(exportResponse.status, 200);
    assert.equal(exportBody.userId, targetUser.id);
    assert.equal(exportBody.sections.memories.length, 1);
    assert.equal(exportBody.sections.sessions.length, 1);
    assert.equal(exportBody.sections.wiki_pages.length, 1);
    assert.equal(exportBody.sections.audit_log.length, 1);

    const eraseResponse = await harness.request(`/api/gdpr/erase/${targetUser.id}`, {
      method: "POST",
      headers: adminHeaders
    });
    const eraseBody = await readJson<ErasureReportPayload>(eraseResponse);

    assert.equal(eraseResponse.status, 200);
    assert.equal(eraseBody.erasedCounts.users, 1);
    assert.deepEqual(eraseBody.anonymized.sort(), ["audit_log", "teams"]);
    assert.equal(harness.repository.getUser(targetUser.id), null);
  } finally {
    revokeDashboardSession(harness.config, memberToken);
    revokeDashboardSession(harness.config, adminToken);
    await harness.cleanup();
  }
});

interface UserDataExportPayload {
  sections: Record<string, Array<Record<string, unknown>>>;
  exportedAt: string;
  userId: string;
}

interface ErasureReportPayload {
  erasedCounts: Record<string, number>;
  erasedAt: string;
  anonymized: string[];
}
