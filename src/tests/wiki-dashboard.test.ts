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
import { SpaceService } from "../wiki/spaces.js";

interface TestHarness {
  baseUrl: string;
  repository: Repository;
  pageManager: PageManager;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const createHarness = async (): Promise<TestHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-wiki-dashboard-"));
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
  const pageManager = new PageManager(repository);
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
    repository,
    pageManager,
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

test("GET /api/wiki/pages returns wiki page list", async () => {
  const harness = await createHarness();

  try {
    harness.pageManager.createPage({
      title: "Auth Runbook",
      content: "Deploy auth changes with smoke tests.",
      summary: "Auth deployment instructions.",
      page_type: "runbook",
      project: "vega"
    });
    const published = harness.pageManager.createPage({
      title: "SQLite Reference",
      content: "WAL mode keeps writes responsive.",
      summary: "SQLite notes.",
      page_type: "reference",
      project: "vega"
    });

    harness.pageManager.updatePage(
      published.id,
      {
        status: "published"
      },
      "Publish reference page"
    );

    const response = await harness.request(
      "/api/wiki/pages?project=vega&page_type=reference&status=published&limit=10"
    );
    const pages = await readJson<
      Array<{
        id: string;
        slug: string;
        title: string;
        page_type: string;
        status: string;
        project: string | null;
        updated_at: string;
        summary: string;
      }>
    >(response);

    assert.equal(response.status, 200);
    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.id, published.id);
    assert.equal(pages[0]?.slug, published.slug);
    assert.equal(pages[0]?.title, "SQLite Reference");
    assert.equal(pages[0]?.page_type, "reference");
    assert.equal(pages[0]?.status, "published");
    assert.equal(pages[0]?.project, "vega");
    assert.equal(typeof pages[0]?.updated_at, "string");
    assert.equal(pages[0]?.summary, "SQLite notes.");
  } finally {
    await harness.cleanup();
  }
});

test("GET /api/wiki/pages/:slug returns page with backlinks", async () => {
  const harness = await createHarness();
  const tenant = new TenantService(harness.repository).createTenant("Docs Tenant", "free");
  const publicSpace = new SpaceService(harness.repository).createSpace(
    "Public Docs",
    "public-docs",
    tenant.id,
    "public"
  );

  try {
    const source = harness.pageManager.createPage({
      title: "SQLite Decisions",
      content: "WAL mode is the default write strategy.",
      summary: "SQLite decisions.",
      page_type: "decision_log",
      project: "vega",
      space_id: publicSpace.id
    });
    const target = harness.pageManager.createPage({
      title: "WAL Runbook",
      content: "Enable WAL mode before production traffic.",
      summary: "Runbook for WAL mode.",
      page_type: "runbook",
      project: "vega",
      space_id: publicSpace.id
    });

    harness.pageManager.addCrossReference(source.id, target.id, "See the WAL runbook.");

    const response = await harness.request(`/api/wiki/pages/${target.slug}`);
    const body = await readJson<{
      page: {
        id: string;
        slug: string;
        title: string;
        content: string;
        version: number;
      };
      backlinks: Array<{
        page_id: string;
        title: string;
        slug: string;
        context: string;
      }>;
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.page.id, target.id);
    assert.equal(body.page.slug, target.slug);
    assert.equal(body.page.title, "WAL Runbook");
    assert.match(body.page.content, /Enable WAL mode/);
    assert.equal(body.page.version, 1);
    assert.deepEqual(body.backlinks, [
      {
        page_id: source.id,
        title: source.title,
        slug: source.slug,
        context: "See the WAL runbook."
      }
    ]);
  } finally {
    await harness.cleanup();
  }
});

test("GET /api/wiki/pages/:slug returns 404 for missing page", async () => {
  const harness = await createHarness();

  try {
    const response = await harness.request("/api/wiki/pages/missing-page");
    const body = await readJson<{ error: string }>(response);

    assert.equal(response.status, 404);
    assert.equal(body.error, "Wiki page not found: missing-page");
  } finally {
    await harness.cleanup();
  }
});

test("private page rejects unauthenticated read", async () => {
  const harness = await createHarness();
  const tenant = new TenantService(harness.repository).createTenant("Private Tenant", "free");
  const privateSpace = new SpaceService(harness.repository).createSpace(
    "Private Docs",
    "private-docs",
    tenant.id,
    "private"
  );

  try {
    const page = harness.pageManager.createPage({
      title: "Private Runbook",
      content: "Restricted content.",
      summary: "Restricted summary.",
      page_type: "runbook",
      space_id: privateSpace.id
    });
    const response = await harness.request(`/api/wiki/pages/${page.slug}`);
    const body = await readJson<{ error: string }>(response);

    assert.equal(response.status, 403);
    assert.equal(body.error, "forbidden");
  } finally {
    await harness.cleanup();
  }
});

test("public page allows unauthenticated read", async () => {
  const harness = await createHarness();
  const tenant = new TenantService(harness.repository).createTenant("Public Tenant", "free");
  const publicSpace = new SpaceService(harness.repository).createSpace(
    "Public Docs",
    "public-docs",
    tenant.id,
    "public"
  );

  try {
    const page = harness.pageManager.createPage({
      title: "Public Runbook",
      content: "Anyone can read this.",
      summary: "Public summary.",
      page_type: "runbook",
      space_id: publicSpace.id
    });
    const response = await harness.request(`/api/wiki/pages/${page.slug}`);
    const body = await readJson<{ page: { id: string } }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.page.id, page.id);
  } finally {
    await harness.cleanup();
  }
});

test("GET /api/wiki/pages/:slug/versions returns version history", async () => {
  const harness = await createHarness();
  const tenant = new TenantService(harness.repository).createTenant("Versions Tenant", "free");
  const publicSpace = new SpaceService(harness.repository).createSpace(
    "Public Versions",
    "public-versions",
    tenant.id,
    "public"
  );

  try {
    const page = harness.pageManager.createPage({
      title: "Cache Strategy",
      content: "Use a local cache.",
      summary: "Initial cache plan.",
      page_type: "topic",
      project: "vega",
      space_id: publicSpace.id
    });

    harness.pageManager.updatePage(
      page.id,
      {
        content: "Use a local cache with explicit invalidation.",
        summary: "Updated cache plan."
      },
      "Clarified invalidation strategy"
    );

    const response = await harness.request(`/api/wiki/pages/${page.slug}/versions`);
    const versions = await readJson<
      Array<{
        id: string;
        page_id: string;
        content: string;
        summary: string;
        version: number;
        change_reason: string;
        created_at: string;
      }>
    >(response);

    assert.equal(response.status, 200);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.page_id, page.id);
    assert.equal(versions[0]?.content, "Use a local cache.");
    assert.equal(versions[0]?.summary, "Initial cache plan.");
    assert.equal(versions[0]?.version, 1);
    assert.equal(versions[0]?.change_reason, "Clarified invalidation strategy");
    assert.equal(typeof versions[0]?.created_at, "string");
  } finally {
    await harness.cleanup();
  }
});

test("POST /api/wiki/search returns FTS results", async () => {
  const harness = await createHarness();

  try {
    const expected = harness.pageManager.createPage({
      title: "SQLite Tuning",
      content: "SQLite tuning covers WAL mode and cache pragmas.",
      summary: "WAL mode tuning guide.",
      page_type: "reference",
      project: "vega"
    });
    harness.pageManager.createPage({
      title: "Redis Notes",
      content: "Redis settings for cache invalidation.",
      summary: "Redis guide.",
      page_type: "reference",
      project: "vega"
    });

    const response = await harness.request("/api/wiki/search", {
      method: "POST",
      body: JSON.stringify({
        query: "WAL",
        project: "vega",
        limit: 10
      })
    });
    const results = await readJson<
      Array<{
        id: string;
        slug: string;
        title: string;
        summary: string;
        page_type: string;
        status: string;
        project: string | null;
        updated_at: string;
      }>
    >(response);

    assert.equal(response.status, 200);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, expected.id);
    assert.equal(results[0]?.slug, expected.slug);
    assert.equal(results[0]?.title, "SQLite Tuning");
    assert.equal(results[0]?.project, "vega");
    assert.equal(results[0]?.page_type, "reference");
    assert.equal(typeof results[0]?.updated_at, "string");
  } finally {
    await harness.cleanup();
  }
});
