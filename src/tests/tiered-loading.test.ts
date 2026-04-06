import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { embeddingCache } from "../embedding/cache.js";
import { SearchEngine } from "../search/engine.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  dbEncryption: false
};

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => {
  const { summary = null, ...rest } = overrides;

  return {
    id: "memory-1",
    type: "project_context",
    project: "vega",
    title: "Stored Memory",
    content: "Use SQLite for memory storage.",
    embedding: null,
    importance: 0.5,
    source: "auto",
    tags: ["sqlite"],
    created_at: "2026-04-03T00:00:00.000Z",
    updated_at: "2026-04-03T00:00:00.000Z",
    accessed_at: "2026-04-03T00:00:00.000Z",
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega"],
    ...rest,
    summary
  };
};

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
};

const installOllamaMock = (options?: {
  chatResolver?: (messages: Array<{ role: string; content: string }>) => string;
  embedVector?: number[];
  failChat?: boolean;
}): (() => void) => {
  const originalFetch = globalThis.fetch;
  embeddingCache.clear();

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = getRequestUrl(input);

    if (url.endsWith("/api/embed")) {
      return new Response(
        JSON.stringify({
          embeddings: [options?.embedVector ?? [0.25, 0.75]]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.endsWith("/api/chat")) {
      if (options?.failChat) {
        return new Response(JSON.stringify({ error: "offline" }), { status: 503 });
      }

      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as {
              messages?: Array<{ role: string; content: string }>;
            })
          : { messages: [] };

      return new Response(
        JSON.stringify({
          message: {
            content: options?.chatResolver?.(body.messages ?? []) ?? "Generated summary"
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return new Response(JSON.stringify({ version: "mock" }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  return () => {
    embeddingCache.clear();
    globalThis.fetch = originalFetch;
  };
};

const createSessionHarness = (config: VegaConfig = baseConfig) => {
  const repository = new Repository(config.dbPath);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, new SearchEngine(repository, config), config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);

  return {
    repository,
    memoryService,
    sessionService
  };
};

const createLongContent = (prefix: string): string =>
  `${prefix}\n${"Investigated the failure path, captured commands, file paths, and resolution details. ".repeat(6)}`;

test("store generates summary for long content", async () => {
  const restoreFetch = installOllamaMock({
    chatResolver: () => "SQLite migration failure fixed by rerunning the schema step in the right order."
  });
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);
  const content = createLongContent(
    "Investigated SQLite migration failure in src/db/schema.ts and fixed the ordering issue."
  );

  try {
    const result = await service.store({
      content,
      type: "decision",
      project: "vega"
    });
    const stored = repository.getMemory(result.id);

    assert.ok(stored);
    assert.notEqual(stored.summary, null);
    assert.ok((stored.summary ?? "").length < stored.content.length);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("store skips summary for short content", async () => {
  let chatCalls = 0;
  const restoreFetch = installOllamaMock({
    chatResolver: () => {
      chatCalls += 1;
      return "unused";
    }
  });
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const result = await service.store({
      content: "Short note about SQLite.",
      type: "decision",
      project: "vega"
    });
    const stored = repository.getMemory(result.id);

    assert.ok(stored);
    assert.equal(stored.summary, null);
    assert.equal(chatCalls, 0);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("session_start token estimate uses summary not content", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-tiered-session-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionHarness();
  const summary = "Short summary for session loading.";

  try {
    repository.createMemory(
      createStoredMemory({
        id: "context-1",
        project,
        content: createLongContent("Long project context that should not dominate token estimation."),
        summary,
        verified: "verified"
      })
    );

    const result = await sessionService.sessionStart(tempDir);

    assert.equal(result.context.length, 1);
    assert.equal(result.context[0]?.summary, summary);
    assert.equal(result.token_estimate, summary.length / 4);
    assert.ok(result.token_estimate < result.context[0]!.content.length / 4);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("update regenerates summary when content changes", async () => {
  const restoreFetch = installOllamaMock({
    chatResolver: (messages) =>
      messages.at(-1)?.content.includes("updated summary marker")
        ? "Updated summary"
        : "Initial summary"
  });
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const stored = await service.store({
      content: createLongContent("initial summary marker with original content"),
      type: "project_context",
      project: "vega"
    });

    await service.update(stored.id, {
      content: createLongContent("updated summary marker with replacement content")
    });

    const refreshed = repository.getMemory(stored.id);

    assert.ok(refreshed);
    assert.equal(refreshed.summary, "Updated summary");
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("summary fallback to truncation when Ollama is unavailable", async () => {
  const restoreFetch = installOllamaMock({ failChat: true });
  const config: VegaConfig = {
    ...baseConfig,
    ollamaBaseUrl: "http://127.0.0.1:1"
  };
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, config);
  const content = createLongContent("Fallback summary content with unreachable Ollama.");

  try {
    const result = await service.store({
      content,
      type: "decision",
      project: "vega"
    });
    const stored = repository.getMemory(result.id);

    assert.ok(stored);
    assert.equal(stored.summary, `${content.slice(0, 200)}...`);
  } finally {
    restoreFetch();
    repository.close();
  }
});
