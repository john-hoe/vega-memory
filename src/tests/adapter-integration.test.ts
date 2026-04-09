import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createAdapterTokenReport, buildAdapterTokenReportMarkdown } from "../adapter/token-report.js";
import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { createMCPServer } from "../mcp/server.js";
import { SearchEngine } from "../search/engine.js";

const createConfig = (tempDir: string, overrides: Partial<VegaConfig> = {}): VegaConfig => ({
  dbPath: join(tempDir, "memory.db"),
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  dbEncryption: false,
  apiPort: 0,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: join(tempDir, "cache.db"),
  telegramBotToken: undefined,
  telegramChatId: undefined,
  ...overrides
});

const createStoredMemory = (
  project: string,
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  tenant_id: null,
  type: "decision",
  project,
  title: "Stored adapter memory",
  content: "Adapter evidence lives in the hot recall path.",
  summary: null,
  embedding: null,
  importance: 0.8,
  source: "explicit",
  tags: ["adapter", "evidence"],
  created_at: "2026-04-10T00:00:00.000Z",
  updated_at: "2026-04-10T00:00:00.000Z",
  accessed_at: "2026-04-10T00:00:00.000Z",
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: [project],
  ...overrides
});

const installEmbeddingMock = (vector = [0.4, 0.6]): (() => void) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/api/embed")) {
      return new Response(
        JSON.stringify({
          embeddings: [vector]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return originalFetch(input, init);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
};

const getRegisteredTools = (
  server: ReturnType<typeof createMCPServer>
): Record<
  string,
  {
    handler: (
      args: Record<string, unknown>,
      extra: object
    ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
  }
> =>
  (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
            extra: object
          ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
        }
      >;
    }
  )._registeredTools;

const parseToolPayload = <T>(result: {
  content: Array<{ text?: string }>;
}): T => JSON.parse(result.content[0]?.text ?? "{}") as T;

const createApiHarness = async (config: VegaConfig) => {
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
    repository,
    async cleanup(): Promise<void> {
      await server.stop();
      repository.close();
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

test("Claude Code MCP workflow supports L1 session_start, recall, store, and session_end", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-adapter-claude-"));
  const workingDirectory = join(tempDir, "claude-workspace");
  const project = basename(workingDirectory);
  const config = createConfig(tempDir);
  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);
  const compactService = new CompactService(repository, config);
  const emptyGraphService = {
    query: () => ({
      entity: null,
      relations: [],
      memories: []
    }),
    getNeighbors: () => ({
      entity: null,
      neighbors: [],
      relations: [],
      memories: []
    }),
    shortestPath: () => ({
      from: null,
      to: null,
      entities: [],
      relations: [],
      memories: [],
      found: false
    }),
    graphStats: () => ({
      total_entities: 0,
      total_relations: 0,
      entity_types: {},
      relation_types: {},
      average_confidence: null,
      tracked_code_files: 0,
      tracked_doc_files: 0
    }),
    subgraph: () => ({
      seed_entities: [],
      missing_entities: [],
      entities: [],
      relations: [],
      memories: []
    })
  };
  const server = createMCPServer({
    repository,
    graphService: emptyGraphService,
    memoryService,
    recallService,
    sessionService,
    compactService,
    config
  });
  const restoreFetch = installEmbeddingMock();

  mkdirSync(workingDirectory, { recursive: true });

  try {
    repository.createMemory(
      createStoredMemory("shared", {
        id: "pref-claude",
        type: "preference",
        project: "shared",
        scope: "global",
        title: "Preference",
        content: "Prefer L1 before widening preload.",
        importance: 0.95,
        accessed_projects: [project]
      })
    );
    repository.createMemory(
      createStoredMemory(project, {
        id: "task-claude",
        type: "task_state",
        title: "Claude task",
        content: "Validate the Claude adapter workflow."
      })
    );
    repository.createMemory(
      createStoredMemory(project, {
        id: "conflict-claude",
        type: "decision",
        title: "Conflict",
        content: "Two loaders disagree on the adapter token policy.",
        verified: "conflict"
      })
    );
    repository.createMemory(
      createStoredMemory(project, {
        id: "warning-claude",
        type: "insight",
        title: "Warning",
        content: "Adapter evidence should use recall before widening preload.",
        tags: ["adapter", "evidence"]
      })
    );
    repository.createMemory(
      createStoredMemory(project, {
        id: "recall-claude",
        title: "Recall memory",
        content: "Adapter evidence and token budget details live in recall."
      })
    );

    const tools = getRegisteredTools(server);
    const sessionStart = parseToolPayload<{
      preferences: Array<{ id: string }>;
      active_tasks: Array<{ id: string }>;
      conflicts: Array<{ id: string }>;
      context: unknown[];
      relevant: unknown[];
      proactive_warnings: string[];
      token_estimate: number;
    }>(
      await tools.session_start.handler(
        {
          working_directory: workingDirectory,
          task_hint: "adapter evidence",
          mode: "L1"
        },
        {}
      )
    );

    assert.deepEqual(
      sessionStart.preferences.map((memory) => memory.id),
      ["pref-claude"]
    );
    assert.deepEqual(
      sessionStart.active_tasks.map((memory) => memory.id),
      ["task-claude"]
    );
    assert.deepEqual(
      sessionStart.conflicts.map((memory) => memory.id),
      ["conflict-claude"]
    );
    assert.deepEqual(sessionStart.context, []);
    assert.deepEqual(sessionStart.relevant, []);
    assert.deepEqual(sessionStart.proactive_warnings, [
      "Adapter evidence should use recall before widening preload."
    ]);
    assert.equal(sessionStart.token_estimate > 0, true);

    const recall = parseToolPayload<Array<{ id: string; content: string }>>(
      await tools.memory_recall.handler(
        {
          query: "adapter evidence",
          project,
          limit: 5,
          min_similarity: 0
        },
        {}
      )
    );

    assert.equal(recall.some((memory) => memory.id === "recall-claude"), true);

    const stored = parseToolPayload<{ id: string; action: string }>(
      await tools.memory_store.handler(
        {
          content: "Validated the Claude Code adapter workflow.",
          type: "task_state",
          project,
          title: "VM2-013 Claude workflow",
          source: "explicit"
        },
        {}
      )
    );

    assert.equal(stored.action, "created");
    assert.ok(repository.getMemory(stored.id));

    await tools.session_end.handler(
      {
        project,
        summary: "We decided the Claude Code adapter should default to L1 for routine coding.",
        completed_tasks: ["task-claude"]
      },
      {}
    );

    const sessionCount = repository.db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM sessions")
      .get()
      ?.count;

    assert.equal(sessionCount, 1);
    assert.equal(repository.getMemory("task-claude")?.importance, 0.2);
  } finally {
    restoreFetch();
    await server.close();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw HTTP workflow uses L0 preload and aggressive recall", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-adapter-openclaw-"));
  const workingDirectory = join(tempDir, "openclaw-workspace");
  const project = basename(workingDirectory);
  const config = createConfig(tempDir);
  const harness = await createApiHarness(config);
  const restoreFetch = installEmbeddingMock();

  mkdirSync(workingDirectory, { recursive: true });

  try {
    harness.repository.createMemory(
      createStoredMemory("shared", {
        id: "pref-openclaw",
        type: "preference",
        project: "shared",
        scope: "global",
        title: "Preference",
        content: "Prefer L0 under token pressure.",
        importance: 0.95,
        accessed_projects: [project]
      })
    );
    harness.repository.createMemory(
      createStoredMemory(project, {
        id: "context-openclaw",
        type: "project_context",
        title: "Context",
        content: "This context should stay out of L0."
      })
    );
    harness.repository.createMemory(
      createStoredMemory(project, {
        id: "recall-openclaw",
        title: "OpenClaw recall memory",
        content: "OpenClaw should aggressively recall adapter token evidence."
      })
    );

    const sessionResponse = await harness.request("/api/session/start", {
      method: "POST",
      body: JSON.stringify({
        working_directory: workingDirectory,
        task_hint: "adapter token evidence",
        mode: "L0"
      })
    });
    const sessionBody = (await sessionResponse.json()) as {
      preferences: Array<{ id: string }>;
      active_tasks: unknown[];
      context: unknown[];
      relevant: unknown[];
      conflicts: unknown[];
      token_estimate: number;
    };

    assert.equal(sessionResponse.status, 200);
    assert.deepEqual(
      sessionBody.preferences.map((memory) => memory.id),
      ["pref-openclaw"]
    );
    assert.deepEqual(sessionBody.active_tasks, []);
    assert.deepEqual(sessionBody.context, []);
    assert.deepEqual(sessionBody.relevant, []);
    assert.deepEqual(sessionBody.conflicts, []);
    assert.equal(sessionBody.token_estimate <= 50, true);

    const recallResponse = await harness.request("/api/recall", {
      method: "POST",
      body: JSON.stringify({
        query: "adapter token evidence",
        project,
        limit: 5,
        min_similarity: 0
      })
    });
    const recallBody = (await recallResponse.json()) as Array<{ id: string; content: string }>;

    assert.equal(recallResponse.status, 200);
    assert.equal(recallBody.some((memory) => memory.id === "recall-openclaw"), true);
  } finally {
    restoreFetch();
    await harness.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("adapter token report compares the L0/L1/L2/L3 savings curve", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-adapter-token-report-config-"));
  const restoreFetch = installEmbeddingMock();

  try {
    const report = await createAdapterTokenReport(createConfig(tempDir));
    const markdown = buildAdapterTokenReportMarkdown(report);

    assert.equal(report.modes.L0.token_estimate < report.modes.L1.token_estimate, true);
    assert.equal(report.modes.L1.token_estimate < report.modes.L2.token_estimate, true);
    assert.equal(report.modes.L2.token_estimate < report.modes.L3.token_estimate, true);
    assert.equal(report.modes.L3.deep_recall_results > 0, true);
    assert.equal(report.deltas.length, 3);
    assert.equal((report.savings_vs_l3_pct.L0 ?? 0) > (report.savings_vs_l3_pct.L2 ?? 0), true);
    assert.match(markdown, /# Vega Memory Adapter Token Report/);
    assert.match(markdown, /\| L0 \|/);
    assert.match(markdown, /\| L3 \|/);
  } finally {
    restoreFetch();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
