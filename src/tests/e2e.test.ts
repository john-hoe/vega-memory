import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  DASHBOARD_AUTH_COOKIE,
  registerDashboardSession,
  revokeDashboardSession
} from "../api/auth.js";
import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { TenantService } from "../core/tenant.js";
import type { MemoryType } from "../core/types.js";
import { UserService } from "../core/user.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";
import { PageManager } from "../wiki/page-manager.js";
import { PagePermissionService } from "../wiki/permissions.js";

const ensureDataDirectory = (dbPath: string): void => {
  if (dbPath === ":memory:") {
    return;
  }

  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
};

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");
const cliModuleUrl = pathToFileURL(cliPath).href;
const childBaseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("VEGA_") && key !== "OLLAMA_BASE_URL" && key !== "OLLAMA_MODEL"
  )
);
const cliBootstrap = `process.argv.splice(1, 0, ${JSON.stringify(cliPath)}); await import(${JSON.stringify(cliModuleUrl)});`;

interface ApiHarness {
  baseUrl: string;
  config: VegaConfig;
  repository: Repository;
  pageManager: PageManager;
  tenantService: TenantService;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const createApiHarness = async (apiKey = "top-secret"): Promise<ApiHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-e2e-api-"));
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
  const sessionService = new SessionService(repository, memoryService, recallService, config);
  const compactService = new CompactService(repository, config);
  const pageManager = new PageManager(repository);
  const tenantService = new TenantService(repository);
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
    pageManager,
    tenantService,
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

      return fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers
      });
    }
  };
};

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

test("E2E: Vega Memory System", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-e2e-"));
  const dbPath = join(tempDir, "memory.db");
  const project = basename(tempDir);
  const previousEnv = {
    VEGA_DB_PATH: process.env.VEGA_DB_PATH,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL
  };

  process.env.VEGA_DB_PATH = dbPath;
  process.env.OLLAMA_BASE_URL = "http://localhost:99999";

  const config = loadConfig();
  ensureDataDirectory(config.dbPath);
  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);
  const compactService = new CompactService(repository, config);

  try {
    await t.test("session_start returns valid structure on empty database", async () => {
      const result = await sessionService.sessionStart(tempDir);

      assert.equal(result.project, project);
      assert.ok("active_tasks" in result);
      assert.ok("preferences" in result);
      assert.ok("context" in result);
      assert.ok("relevant" in result);
      assert.ok("recent_unverified" in result);
      assert.ok("conflicts" in result);
      assert.ok("proactive_warnings" in result);
      assert.equal(Array.isArray(result.active_tasks), true);
      assert.equal(Array.isArray(result.preferences), true);
      assert.equal(Array.isArray(result.context), true);
      assert.equal(Array.isArray(result.relevant), true);
      assert.equal(Array.isArray(result.recent_unverified), true);
      assert.equal(Array.isArray(result.conflicts), true);
      assert.equal(Array.isArray(result.proactive_warnings), true);
      assert.equal(typeof result.token_estimate, "number");
    });

    await t.test("store 5 different memory types", async () => {
      const cases: Array<{
        type: MemoryType;
        title: string;
        content: string;
      }> = [
        {
          type: "task_state",
          title: "E2E Task State",
          content: "Implement the end-to-end test workflow for Vega Memory."
        },
        {
          type: "preference",
          title: "E2E Preference",
          content: "Always keep CLI test output concise and machine-readable."
        },
        {
          type: "project_context",
          title: "E2E Project Context",
          content: "The project uses SQLite, FTS5, commander, and MCP tooling."
        },
        {
          type: "decision",
          title: "E2E Decision",
          content: "Use a real SQLite file for end-to-end coverage."
        },
        {
          type: "pitfall",
          title: "E2E Pitfall",
          content: "FFmpeg path bugs happen when relative paths are used."
        }
      ];

      for (const entry of cases) {
        const result = await memoryService.store({
          content: entry.content,
          type: entry.type,
          project,
          title: entry.title
        });

        assert.equal(typeof result.id, "string");
        assert.equal(result.action, "created");
        assert.equal(result.title, entry.title);
      }
    });

    await t.test("list memories returns all stored", () => {
      const memories = recallService.listMemories({});

      assert.ok(memories.length >= 5);
    });

    await t.test(
      "store duplicate merges create new records when embeddings are unavailable",
      async () => {
        const duplicateContent = "Duplicate memory without embeddings should not merge.";

        const first = await memoryService.store({
          content: duplicateContent,
          type: "decision",
          project
        });
        const second = await memoryService.store({
          content: duplicateContent,
          type: "decision",
          project
        });
        const duplicates = recallService
          .listMemories({
            project,
            type: "decision",
            limit: 1_000
          })
          .filter((memory) => memory.content === duplicateContent);

        assert.equal(first.action, "created");
        assert.equal(second.action, "created");
        assert.equal(duplicates.length, 2);
      }
    );

    await t.test("update creates version history", async () => {
      const stored = await memoryService.store({
        content: "Initial content for version history coverage.",
        type: "insight",
        project,
        title: "Versioned Memory"
      });

      await memoryService.update(stored.id, {
        content: "Updated content for version history coverage."
      });

      const versions = repository.getVersions(stored.id);

      assert.ok(versions.length >= 1);
    });

    await t.test("session_end creates session record", async () => {
      const summary = "修复了FFmpeg路径bug，决定使用绝对路径";

      await sessionService.sessionEnd(project, summary);

      const sessionRow = repository.db
        .prepare<[string], { project: string; summary: string; memories_created: string }>(
          `SELECT project, summary, memories_created
           FROM sessions
           WHERE project = ?
           ORDER BY ended_at DESC
           LIMIT 1`
        )
        .get(project);

      assert.ok(sessionRow);
      assert.equal(sessionRow.project, project);
      assert.equal(sessionRow.summary, summary);
      assert.ok(JSON.parse(sessionRow.memories_created).length >= 1);
    });

    await t.test("compact archives low importance", async () => {
      const stored = await memoryService.store({
        content: "Archive this low-importance memory during compaction.",
        type: "insight",
        project,
        title: "Low Importance Memory",
        importance: 0.05
      });

      const result = compactService.compact(project);
      const archived = repository.getMemory(stored.id);

      assert.ok(result.archived >= 1);
      assert.ok(archived);
      assert.equal(archived.status, "archived");
    });

    await t.test("health check returns valid report", () => {
      const report = {
        memory_count: repository.listMemories({ limit: 1_000_000 }).length,
        db_exists: existsSync(dbPath)
      };

      assert.ok(report.memory_count >= 1);
      assert.equal(report.db_exists, true);
    });

    await t.test("audit log tracks operations", () => {
      const auditLog = repository.getAuditLog();

      assert.ok(auditLog.length >= 1);
      assert.equal(auditLog.some((entry) => entry.action === "store_created"), true);
      assert.equal(auditLog.some((entry) => entry.action === "update"), true);
    });

    await t.test("CLI health command exits non-zero for degraded local setups while still printing health details", () => {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", cliBootstrap, "--", "health"],
        {
          cwd: projectRoot,
          encoding: "utf8",
          env: {
            ...childBaseEnv,
            VEGA_DB_PATH: dbPath,
            OLLAMA_BASE_URL: "http://localhost:99999"
          }
        }
      );

      assert.equal(result.status, 1);
      assert.match(result.stdout ?? "", /memory count:/i);
      assert.match(result.stdout ?? "", /status: degraded/i);
    });

    await t.test("HTTP API memory lifecycle supports store, recall, update, list, and delete", async () => {
      const harness = await createApiHarness();

      try {
        const storeResponse = await harness.request("/api/store", {
          method: "POST",
          body: JSON.stringify({
            content: "Track the full API lifecycle in one E2E flow.",
            type: "task_state",
            project: "vega-e2e",
            title: "Lifecycle Memory"
          })
        });
        const stored = await readJson<{
          id: string;
          action: string;
          title: string;
        }>(storeResponse);
        const recallResponse = await harness.request("/api/recall", {
          method: "POST",
          body: JSON.stringify({
            query: "full API lifecycle",
            project: "vega-e2e",
            limit: 5,
            min_similarity: 0
          })
        });
        const recalled = await readJson<
          Array<{
            id: string;
            content: string;
          }>
        >(recallResponse);
        const updateResponse = await harness.request(`/api/memory/${stored.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            content: "Track the full API lifecycle after an update step.",
            tags: ["e2e", "lifecycle"]
          })
        });
        const listed = await readJson<
          Array<{
            id: string;
            content: string;
            tags: string[];
          }>
        >(await harness.request("/api/list?project=vega-e2e&limit=10"));
        const deleteResponse = await harness.request(`/api/memory/${stored.id}`, {
          method: "DELETE"
        });
        const remaining = await readJson<Array<{ id: string }>>(
          await harness.request("/api/list?project=vega-e2e&limit=10")
        );

        assert.equal(storeResponse.status, 200);
        assert.equal(stored.action, "created");
        assert.equal(stored.title, "Lifecycle Memory");
        assert.equal(recallResponse.status, 200);
        assert.equal(recalled.length, 1);
        assert.equal(recalled[0]?.id, stored.id);
        assert.equal(updateResponse.status, 200);
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.id, stored.id);
        assert.equal(listed[0]?.content, "Track the full API lifecycle after an update step.");
        assert.deepEqual(listed[0]?.tags, ["e2e", "lifecycle"]);
        assert.equal(deleteResponse.status, 200);
        assert.equal(remaining.length, 0);
      } finally {
        await harness.cleanup();
      }
    });

    await t.test("tenant-scoped API requests keep tenant data isolated", async () => {
      const harness = await createApiHarness();
      const tenantA = harness.tenantService.createTenant("Tenant A", "pro");
      const tenantB = harness.tenantService.createTenant("Tenant B", "pro");
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
            content: "tenant alpha memory",
            type: "insight",
            project: "tenant-e2e"
          })
        });
        await harness.request("/api/store", {
          method: "POST",
          headers: tenantBHeaders,
          body: JSON.stringify({
            content: "tenant beta memory",
            type: "insight",
            project: "tenant-e2e"
          })
        });

        const tenantAList = await readJson<Array<{ content: string }>>(
          await harness.request("/api/list?project=tenant-e2e&limit=10", {
            headers: tenantAHeaders
          })
        );
        const tenantBList = await readJson<Array<{ content: string }>>(
          await harness.request("/api/list?project=tenant-e2e&limit=10", {
            headers: tenantBHeaders
          })
        );

        assert.deepEqual(
          tenantAList.map((memory) => memory.content),
          ["tenant alpha memory"]
        );
        assert.deepEqual(
          tenantBList.map((memory) => memory.content),
          ["tenant beta memory"]
        );
      } finally {
        await harness.cleanup();
      }
    });

    await t.test("OIDC login route is reachable and reports redirect or configuration errors", async () => {
      const harness = await createApiHarness();

      try {
        const response = await harness.request("/api/auth/oidc/login", {
          redirect: "manual"
        });

        if (response.status === 302) {
          assert.equal(typeof response.headers.get("location"), "string");
        } else {
          const body = await readJson<{ error: string }>(response);

          assert.ok(response.status === 400 || response.status === 503);
          assert.equal(typeof body.error, "string");
          assert.ok(body.error.length > 0);
        }
      } finally {
        await harness.cleanup();
      }
    });

    await t.test("wiki spaces support comments on tenant-scoped pages", async () => {
      const harness = await createApiHarness();
      const tenant = harness.tenantService.createTenant("Wiki Tenant", "pro");
      const permissionService = new PagePermissionService(harness.repository);
      const user = new UserService(harness.repository).createUser(
        "alice@example.com",
        "Alice",
        "member",
        tenant.id
      );
      const tenantHeaders = {
        authorization: `Bearer ${tenant.api_key}`
      };

      try {
        const createSpaceResponse = await harness.request("/api/wiki/spaces", {
          method: "POST",
          headers: tenantHeaders,
          body: JSON.stringify({
            name: "Operations",
            slug: "operations"
          })
        });
        const space = await readJson<{
          id: string;
          slug: string;
        }>(createSpaceResponse);
        const page = harness.pageManager.createPage({
          title: "Deployment Runbook",
          content: "Deploy the scheduler before enabling the dashboard.",
          summary: "Deployment steps for Vega.",
          page_type: "runbook",
          space_id: space.id
        });
        permissionService.setPermission(page.id, user.id, "write");
        const createCommentResponse = await harness.request(`/api/wiki/pages/${page.id}/comments`, {
          method: "POST",
          headers: tenantHeaders,
          body: JSON.stringify({
            user_id: user.id,
            content: "Verified on staging."
          })
        });
        const createdComment = await readJson<{
          id: string;
          page_id: string;
          user_id: string;
          content: string;
        }>(createCommentResponse);
        const listCommentsResponse = await harness.request(`/api/wiki/pages/${page.id}/comments`, {
          headers: tenantHeaders
        });
        const comments = await readJson<
          Array<{
            id: string;
            page_id: string;
            author: string;
            content: string;
          }>
        >(listCommentsResponse);

        assert.equal(createSpaceResponse.status, 201);
        assert.equal(space.slug, "operations");
        assert.equal(createCommentResponse.status, 201);
        assert.equal(createdComment.page_id, page.id);
        assert.equal(createdComment.user_id, user.id);
        assert.equal(createdComment.content, "Verified on staging.");
        assert.equal(listCommentsResponse.status, 200);
        assert.equal(comments.length, 1);
        assert.equal(comments[0]?.id, createdComment.id);
      } finally {
        await harness.cleanup();
      }
    });

    await t.test("admin dashboard rejects members and allows admins", async () => {
      const harness = await createApiHarness();
      const tenant = harness.tenantService.createTenant("Dashboard Tenant", "pro");
      const userService = new UserService(harness.repository);
      const member = userService.createUser(
        "member@example.com",
        "Member User",
        "member",
        tenant.id
      );
      const admin = userService.createUser(
        "admin@example.com",
        "Admin User",
        "admin",
        tenant.id
      );
      const memberToken = "member-dashboard-session";
      const adminToken = "admin-dashboard-session";

      registerDashboardSession(harness.config, memberToken, member);
      registerDashboardSession(harness.config, adminToken, admin);

      try {
        const memberResponse = await harness.request("/api/admin/dashboard", {
          headers: {
            authorization: "",
            cookie: `${DASHBOARD_AUTH_COOKIE}=${memberToken}`
          }
        });
        const memberBody = await readJson<{ error: string }>(memberResponse);
        const adminResponse = await harness.request("/api/admin/dashboard", {
          headers: {
            authorization: "",
            cookie: `${DASHBOARD_AUTH_COOKIE}=${adminToken}`
          }
        });
        const adminBody = await readJson<{
          total_users: number;
          total_memories: number;
          active_tenants: number;
          recent_audit_events: unknown[];
        }>(adminResponse);

        assert.equal(memberResponse.status, 403);
        assert.equal(memberBody.error, "forbidden");
        assert.equal(adminResponse.status, 200);
        assert.equal(typeof adminBody.total_users, "number");
        assert.equal(typeof adminBody.total_memories, "number");
        assert.equal(typeof adminBody.active_tenants, "number");
        assert.equal(Array.isArray(adminBody.recent_audit_events), true);
      } finally {
        revokeDashboardSession(harness.config, memberToken);
        revokeDashboardSession(harness.config, adminToken);
        await harness.cleanup();
      }
    });

    await t.test("health endpoint returns 200 for Docker-style health checks", async () => {
      const harness = await createApiHarness();

      try {
        const response = await harness.request("/api/health");
        const body = await readJson<{ status: string }>(response);

        assert.equal(response.status, 200);
        assert.equal(typeof body.status, "string");
      } finally {
        await harness.cleanup();
      }
    });
  } finally {
    repository.close();

    if (previousEnv.VEGA_DB_PATH === undefined) {
      delete process.env.VEGA_DB_PATH;
    } else {
      process.env.VEGA_DB_PATH = previousEnv.VEGA_DB_PATH;
    }

    if (previousEnv.OLLAMA_BASE_URL === undefined) {
      delete process.env.OLLAMA_BASE_URL;
    } else {
      process.env.OLLAMA_BASE_URL = previousEnv.OLLAMA_BASE_URL;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});
