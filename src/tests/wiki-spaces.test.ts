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
import { TenantService } from "../core/tenant.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";
import { PageManager } from "../wiki/page-manager.js";
import { PagePermissionService } from "../wiki/permissions.js";
import { SpaceService } from "../wiki/spaces.js";

interface TestHarness {
  repository: Repository;
  tenantId: string;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const createRepository = (): Repository => new Repository(":memory:");

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const createHarness = async (): Promise<TestHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-wiki-spaces-"));
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
    dbEncryption: false
  };
  const repository = new Repository(config.dbPath);
  const tenant = new TenantService(repository).createTenant("Wiki Tenant", "free");
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
    repository,
    tenantId: tenant.id,
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

test("SpaceService supports CRUD operations for tenant-scoped wiki spaces", () => {
  const repository = createRepository();
  const tenantService = new TenantService(repository);
  const spaceService = new SpaceService(repository);

  try {
    const primaryTenant = tenantService.createTenant("Alpha", "free");
    const secondaryTenant = tenantService.createTenant("Beta", "free");
    const created = spaceService.createSpace("Engineering", "engineering", primaryTenant.id);

    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.visibility, "internal");
    assert.equal(spaceService.getSpace(created.id)?.name, "Engineering");
    assert.equal(spaceService.getSpaceBySlug("engineering", primaryTenant.id)?.id, created.id);
    assert.equal(spaceService.listSpaces(primaryTenant.id).length, 1);
    assert.equal(spaceService.listSpaces(secondaryTenant.id).length, 0);

    spaceService.updateSpace(created.id, {
      name: "Platform Engineering",
      slug: "platform",
      visibility: "private"
    });

    const updated = spaceService.getSpace(created.id);

    assert.ok(updated);
    assert.equal(updated.name, "Platform Engineering");
    assert.equal(updated.slug, "platform");
    assert.equal(updated.visibility, "private");
    assert.equal(spaceService.getSpaceBySlug("platform", primaryTenant.id)?.id, created.id);

    spaceService.deleteSpace(created.id);

    assert.equal(spaceService.getSpace(created.id), null);
    assert.equal(spaceService.listSpaces(primaryTenant.id).length, 0);
  } finally {
    repository.close();
  }
});

test("SpaceService validates supported visibility values", () => {
  const repository = createRepository();
  const tenant = new TenantService(repository).createTenant("Alpha", "free");
  const spaceService = new SpaceService(repository);

  try {
    assert.throws(
      () =>
        spaceService.createSpace(
          "Hidden",
          "hidden",
          tenant.id,
          "partner" as "private"
        ),
      /Unsupported wiki space visibility/
    );
  } finally {
    repository.close();
  }
});

test("PageManager auto-assigns a default workspace space for tenantless pages", () => {
  const repository = createRepository();
  const pageManager = new PageManager(repository);
  const spaceService = new SpaceService(repository);

  try {
    const page = pageManager.createPage({
      title: "Runtime Notes",
      content: "Local workspace wiki content.",
      summary: "Local wiki summary.",
      page_type: "runbook",
      project: "vega-memory"
    });
    const spaces = spaceService.listSpaces(null);

    assert.notEqual(page.space_id, null);
    assert.equal(spaces.length, 1);
    assert.equal(spaces[0]?.tenant_id, null);
    assert.equal(spaces[0]?.slug, "vega-memory-wiki");
  } finally {
    repository.close();
  }
});

test("PagePermissionService resolves direct, role-based, and visibility-based access", () => {
  const repository = createRepository();
  const tenant = new TenantService(repository).createTenant("Alpha", "free");
  const spaceService = new SpaceService(repository);
  const pageManager = new PageManager(repository);
  const permissionService = new PagePermissionService(repository);

  try {
    const internalSpace = spaceService.createSpace("Internal", "internal", tenant.id);
    const privateSpace = spaceService.createSpace("Private", "private", tenant.id, "private");
    const publicSpace = spaceService.createSpace("Public", "public", tenant.id, "public");
    const internalPage = pageManager.createPage({
      title: "Internal Page",
      content: "Internal content",
      summary: "Internal summary",
      page_type: "reference",
      space_id: internalSpace.id
    });
    const privatePage = pageManager.createPage({
      title: "Private Page",
      content: "Private content",
      summary: "Private summary",
      page_type: "reference",
      space_id: privateSpace.id
    });
    const publicPage = pageManager.createPage({
      title: "Public Page",
      content: "Public content",
      summary: "Public summary",
      page_type: "reference",
      space_id: publicSpace.id
    });

    assert.equal(permissionService.canAccess(internalPage.id, "user-1", "member", "read"), true);
    assert.equal(permissionService.canAccess(internalPage.id, undefined, undefined, "read"), false);
    assert.equal(permissionService.canAccess(privatePage.id, "user-1", "member", "read"), false);
    assert.equal(permissionService.canAccess(publicPage.id, undefined, undefined, "read"), true);
    assert.equal(permissionService.canAccess(publicPage.id, undefined, undefined, "write"), false);

    permissionService.setRolePermission(privatePage.id, "member", "write");
    permissionService.setPermission(privatePage.id, "user-2", "admin");

    assert.deepEqual(permissionService.getPermissions(privatePage.id), [
      {
        page_id: privatePage.id,
        role: "member",
        level: "write"
      },
      {
        page_id: privatePage.id,
        user_id: "user-2",
        level: "admin"
      }
    ]);
    assert.equal(permissionService.canAccess(privatePage.id, "user-1", "member", "read"), true);
    assert.equal(permissionService.canAccess(privatePage.id, "user-1", "member", "write"), true);
    assert.equal(permissionService.canAccess(privatePage.id, "user-1", "member", "admin"), false);
    assert.equal(permissionService.canAccess(privatePage.id, "user-2", "viewer", "admin"), true);
    assert.equal(permissionService.canAccess(privatePage.id, "user-3", "admin", "admin"), true);

    permissionService.removePermission(privatePage.id, "user-2");

    assert.equal(permissionService.canAccess(privatePage.id, "user-2", "viewer", "admin"), false);
  } finally {
    repository.close();
  }
});

test("wiki space and permission API routes support create, update, listing, and assignment", async () => {
  const harness = await createHarness();
  const pageManager = new PageManager(harness.repository);

  try {
    const createResponse = await harness.request("/api/wiki/spaces", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: harness.tenantId,
        name: "Docs",
        slug: "docs"
      })
    });
    const created = await readJson<{
      id: string;
      name: string;
      slug: string;
      visibility: string;
    }>(createResponse);

    assert.equal(createResponse.status, 201);
    assert.equal(created.name, "Docs");
    assert.equal(created.visibility, "internal");

    const page = pageManager.createPage({
      title: "Runbook",
      content: "Run the deployment flow.",
      summary: "Deployment summary.",
      page_type: "runbook",
      space_id: created.id
    });

    const listResponse = await harness.request(`/api/wiki/spaces?tenant_id=${harness.tenantId}`);
    const listed = await readJson<Array<{ id: string }>>(listResponse);
    const updateResponse = await harness.request(`/api/wiki/spaces/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        tenant_id: harness.tenantId,
        name: "Platform Docs",
        visibility: "public"
      })
    });
    const updated = await readJson<{
      id: string;
      name: string;
      visibility: string;
    }>(updateResponse);
    const pagesResponse = await harness.request(
      `/api/wiki/spaces/${created.id}/pages?tenant_id=${harness.tenantId}`
    );
    const pages = await readJson<Array<{ id: string; space_id: string | null }>>(pagesResponse);
    const permissionResponse = await harness.request(`/api/wiki/pages/${page.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({
        role: "member",
        level: "write"
      })
    });
    const permissionBody = await readJson<{
      action: string;
      permissions: Array<{ role?: string; level: string }>;
    }>(permissionResponse);

    assert.equal(listResponse.status, 200);
    assert.deepEqual(listed.map((space) => space.id), [created.id]);
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.name, "Platform Docs");
    assert.equal(updated.visibility, "public");
    assert.equal(pagesResponse.status, 200);
    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.id, page.id);
    assert.equal(pages[0]?.space_id, created.id);
    assert.equal(permissionResponse.status, 200);
    assert.equal(permissionBody.action, "updated");
    assert.deepEqual(permissionBody.permissions, [
      {
        page_id: page.id,
        role: "member",
        level: "write"
      }
    ]);
  } finally {
    await harness.cleanup();
  }
});
