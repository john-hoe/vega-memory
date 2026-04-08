import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
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
import { LoadTester } from "./load-test.js";

interface TestHarness {
  baseUrl: string;
  config: VegaConfig;
  repository: Repository;
  pageManager: PageManager;
  tenantService: TenantService;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const createHarness = async (apiKey = "top-secret"): Promise<TestHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-e2e-sla-"));
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
  const pageManager = new PageManager(repository);
  const sessionService = new SessionService(repository, memoryService, recallService, config, pageManager);
  const compactService = new CompactService(repository, config);
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
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
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

      return fetch(`${baseUrl}${path}`, {
        ...init,
        headers
      });
    }
  };
};

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

test("SLA E2E: full memory lifecycle via API", async () => {
  const harness = await createHarness();

  try {
    const storeResponse = await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "Track the SLA memory lifecycle end to end.",
        type: "task_state",
        project: "sla-e2e",
        title: "SLA Lifecycle Memory"
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
        query: "\"SLA memory lifecycle\"",
        project: "sla-e2e",
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
        content: "Track the SLA memory lifecycle after the update step.",
        tags: ["sla", "e2e"]
      })
    });
    const listed = await readJson<
      Array<{
        id: string;
        content: string;
        tags: string[];
      }>
    >(await harness.request("/api/list?project=sla-e2e&limit=10"));
    const deleteResponse = await harness.request(`/api/memory/${stored.id}`, {
      method: "DELETE"
    });
    const remaining = await readJson<Array<{ id: string }>>(
      await harness.request("/api/list?project=sla-e2e&limit=10")
    );

    assert.equal(storeResponse.status, 200);
    assert.equal(stored.action, "created");
    assert.equal(stored.title, "SLA Lifecycle Memory");
    assert.equal(recallResponse.status, 200);
    assert.equal(recalled[0]?.id, stored.id);
    assert.match(recalled[0]?.content ?? "", /lifecycle/i);
    assert.equal(updateResponse.status, 200);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.content, "Track the SLA memory lifecycle after the update step.");
    assert.deepEqual(listed[0]?.tags, ["sla", "e2e"]);
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(remaining, []);
  } finally {
    await harness.cleanup();
  }
});

test("SLA E2E: multi-tenant isolation keeps tenant data separate", async () => {
  const harness = await createHarness();
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
        content: "tenant alpha only memory",
        type: "insight",
        project: "tenant-sla"
      })
    });
    await harness.request("/api/store", {
      method: "POST",
      headers: tenantBHeaders,
      body: JSON.stringify({
        content: "tenant beta only memory",
        type: "insight",
        project: "tenant-sla"
      })
    });

    const tenantAListResponse = await harness.request("/api/list?project=tenant-sla&limit=10", {
      headers: tenantAHeaders
    });
    const tenantAList = await readJson<Array<{ content: string }>>(tenantAListResponse);
    const tenantARecallResponse = await harness.request("/api/recall", {
      method: "POST",
      headers: tenantAHeaders,
      body: JSON.stringify({
        query: "tenant",
        project: "tenant-sla",
        limit: 10,
        min_similarity: 0
      })
    });
    const tenantARecall = await readJson<Array<{ content: string }>>(tenantARecallResponse);

    assert.equal(tenantAListResponse.status, 200);
    assert.deepEqual(
      tenantAList.map((memory) => memory.content),
      ["tenant alpha only memory"]
    );
    assert.equal(tenantARecallResponse.status, 200);
    assert.deepEqual(
      tenantARecall.map((memory) => memory.content),
      ["tenant alpha only memory"]
    );
    assert.equal(
      tenantAList.some((memory) => memory.content.includes("beta")),
      false
    );
    assert.equal(
      tenantARecall.some((memory) => memory.content.includes("beta")),
      false
    );
  } finally {
    await harness.cleanup();
  }
});

test("SLA E2E: session lifecycle starts, persists summary, and demotes completed tasks", async () => {
  const harness = await createHarness();
  const workingDirectory = mkdtempSync(join(tmpdir(), "vega-sla-session-"));
  const project = basename(workingDirectory);

  try {
    const taskStoreResponse = await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "Finish the session lifecycle task.",
        type: "task_state",
        project,
        title: "Session Lifecycle Task",
        importance: 0.9
      })
    });
    const storedTask = await readJson<{ id: string }>(taskStoreResponse);
    const contextStoreResponse = await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "Session lifecycle context for the current project.",
        type: "project_context",
        project,
        title: "Session Context"
      })
    });

    assert.equal(taskStoreResponse.status, 200);
    assert.equal(contextStoreResponse.status, 200);

    const startResponse = await harness.request("/api/session/start", {
      method: "POST",
      body: JSON.stringify({
        working_directory: workingDirectory,
        task_hint: "session lifecycle"
      })
    });
    const startBody = await readJson<{
      project: string;
      active_tasks: Array<{ id: string }>;
      context: Array<{ id: string }>;
    }>(startResponse);
    const endResponse = await harness.request("/api/session/end", {
      method: "POST",
      body: JSON.stringify({
        project,
        summary: "We decided to close the session lifecycle task and fixed the summary persistence flow.",
        completed_tasks: [storedTask.id]
      })
    });
    const sessionRow = harness.repository.db
      .prepare<[string], { project: string; summary: string }>(
        "SELECT project, summary FROM sessions WHERE project = ? ORDER BY ended_at DESC LIMIT 1"
      )
      .get(project);
    const updatedTask = harness.repository.getMemory(storedTask.id);

    assert.equal(startResponse.status, 200);
    assert.equal(startBody.project, project);
    assert.deepEqual(
      startBody.active_tasks.map((memory) => memory.id),
      [storedTask.id]
    );
    assert.equal(startBody.context.length, 1);
    assert.equal(endResponse.status, 200);
    assert.equal(sessionRow?.project, project);
    assert.match(sessionRow?.summary ?? "", /summary persistence flow/);
    assert.equal(updatedTask?.importance, 0.2);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
    await harness.cleanup();
  }
});

test("SLA E2E: search quality ranks the exact memory first", async () => {
  const harness = await createHarness();
  const project = "search-sla";
  const targetContent = "Unique phrase nebula quartz zebra target memory";
  const distractors = [
    "General project notes about search ranking behavior",
    "Another memory covering latency percentiles and RPS",
    "Wiki indexing notes for runbooks and guides",
    "Operational checklist for deployment sequencing"
  ];

  try {
    for (const content of [targetContent, ...distractors]) {
      const response = await harness.request("/api/store", {
        method: "POST",
        body: JSON.stringify({
          content,
          type: "insight",
          project
        })
      });

      assert.equal(response.status, 200);
    }

    const recallResponse = await harness.request("/api/recall", {
      method: "POST",
      body: JSON.stringify({
        query: "\"nebula quartz zebra\"",
        project,
        limit: 5,
        min_similarity: 0
      })
    });
    const results = await readJson<
      Array<{
        id: string;
        content: string;
        finalScore: number;
      }>
    >(recallResponse);

    assert.equal(recallResponse.status, 200);
    assert.ok(results.length >= 1);
    assert.equal(results[0]?.content, targetContent);
    assert.ok((results[0]?.finalScore ?? 0) >= (results[1]?.finalScore ?? 0));
  } finally {
    await harness.cleanup();
  }
});

test("SLA E2E: wiki page lifecycle supports create, update, search, and delete", async () => {
  const harness = await createHarness();

  try {
    const page = harness.pageManager.createPage({
      title: "SLA Runbook",
      content: "Unique wiki lifecycle token page content.",
      summary: "Runbook covering the wiki lifecycle flow.",
      page_type: "runbook",
      project: "vega"
    });
    const updated = harness.pageManager.updatePage(
      page.id,
      {
        content: "Unique wiki lifecycle token page content updated.",
        summary: "Updated wiki lifecycle runbook summary."
      },
      "Refresh lifecycle coverage"
    );
    const searchResponse = await harness.request("/api/wiki/search", {
      method: "POST",
      body: JSON.stringify({
        query: "\"wiki lifecycle token\"",
        project: "vega",
        limit: 5
      })
    });
    const results = await readJson<
      Array<{
        id: string;
        slug: string;
        summary: string;
      }>
    >(searchResponse);

    harness.pageManager.deletePage(page.id);

    assert.equal(updated.version, 2);
    assert.equal(searchResponse.status, 200);
    assert.equal(results[0]?.id, page.id);
    assert.equal(results[0]?.slug, page.slug);
    assert.match(results[0]?.summary ?? "", /Updated wiki lifecycle/);
    assert.equal(harness.pageManager.getPage(page.id), null);
  } finally {
    await harness.cleanup();
  }
});

test("SLA E2E: LoadTester smoke scenario produces a markdown report", async () => {
  const loadTester = new LoadTester({
    baseUrl: "http://127.0.0.1:3100",
    concurrency: 12,
    duration: 30,
    apiKey: "top-secret"
  });

  const result = await loadTester.runScenario({
    name: "memory smoke",
    requests: [
      {
        method: "POST",
        path: "/api/store",
        body: {
          content: "load smoke memory",
          type: "insight",
          project: "vega"
        }
      },
      {
        method: "POST",
        path: "/api/recall",
        body: {
          query: "load smoke",
          project: "vega",
          limit: 5
        }
      }
    ],
    rampUpSeconds: 5
  });
  const report = await loadTester.generateReport([result]);

  assert.ok(result.totalRequests > 0);
  assert.ok(result.successRate > 0);
  assert.ok(result.p50 <= result.p95);
  assert.ok(result.p95 <= result.p99);
  assert.match(report, /\| Total Requests \| Success Rate \|/);
  assert.match(report, /Synthetic aggregate success rate:/);
});
