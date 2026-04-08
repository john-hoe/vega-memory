import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { PageManager } from "../wiki/page-manager.js";
import { SynthesisEngine } from "../wiki/synthesis.js";

const testConfig: VegaConfig = {
  dbPath: ":memory:",
  dbEncryption: false,
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "test-chat-model",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
};

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => {
  const { summary = null, ...rest } = overrides;

  return {
    id: "memory-1",
    tenant_id: null,
    type: "insight",
    project: "vega",
    title: "Auth memory",
    content: "Auth configuration changed for the wiki pipeline.",
    summary,
    embedding: null,
    importance: 0.8,
    source: "explicit",
    tags: ["auth"],
    created_at: "2026-04-06T00:00:00.000Z",
    updated_at: "2026-04-06T00:00:00.000Z",
    accessed_at: "2026-04-06T00:00:00.000Z",
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega"],
    ...rest
  };
};

const installOllamaMock = (chatResponses: string[] = ["## Synthesized Content\n\nThis is a test synthesis."]) => {
  const originalFetch = globalThis.fetch;
  const chatRequests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  let chatIndex = 0;

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/api/chat")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      chatRequests.push(body);
      const content = chatResponses[Math.min(chatIndex, chatResponses.length - 1)];
      chatIndex += 1;

      return new Response(
        JSON.stringify({
          message: { content }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.includes("/api/embed")) {
      return new Response(
        JSON.stringify({
          embeddings: [Array.from({ length: 8 }, () => 0.1)]
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

  return {
    chatRequests,
    restore: () => {
      globalThis.fetch = originalFetch;
    }
  };
};

const createHarness = () => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const synthesisEngine = new SynthesisEngine(repository, pageManager, testConfig);

  return {
    repository,
    pageManager,
    synthesisEngine
  };
};

test("synthesize creates a new wiki page from memories", async () => {
  const mock = installOllamaMock();
  const { repository, pageManager, synthesisEngine } = createHarness();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        title: "Auth setup",
        content: "Auth uses token refresh for wiki synthesis.",
        tags: ["auth", "wiki"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-2",
        title: "Auth deployment",
        content: "Auth deploy needs `npm run build` before release.",
        tags: ["auth", "deploy"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-3",
        title: "Auth regression",
        content: "Auth regression showed `401 unauthorized` during tests.",
        tags: ["auth", "testing"]
      })
    );

    const result = await synthesisEngine.synthesize("auth", "vega");
    const page = pageManager.getPage(result.page_id);

    assert.equal(result.action, "created");
    assert.equal(result.memories_used, 3);
    assert.ok(page);
    assert.equal(page.slug, "auth");
    assert.equal(page.status, "draft");
    assert.equal(page.auto_generated, true);
    assert.equal(page.summary, "This is a test synthesis.");
    assert.equal(page.page_type, "project");
    assert.deepEqual(page.source_memory_ids.sort(), ["memory-1", "memory-2", "memory-3"]);
    assert.ok(page.content.includes("## Sources"));
    assert.ok(page.content.includes("- memory-1"));
  } finally {
    mock.restore();
    repository.close();
  }
});

test("synthesize falls back to deterministic output when Ollama model does not support chat", async () => {
  const originalFetch = globalThis.fetch;
  const { repository, pageManager, synthesisEngine } = createHarness();

  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input);

    if (url.includes("/api/chat")) {
      return new Response(JSON.stringify({ error: "\"bge-m3\" does not support chat" }), {
        status: 400,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    if (url.includes("/api/embed")) {
      return new Response(
        JSON.stringify({
          embeddings: [Array.from({ length: 8 }, () => 0.1)]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return originalFetch(input);
  }) as typeof fetch;

  try {
    repository.createMemory(
      createStoredMemory({
        id: "auth-1",
        title: "Auth Rollout",
        content: "Auth rollout requires token refresh before deploy.",
        tags: ["auth"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "auth-2",
        title: "Auth Incident",
        content: "Auth failed after stale secrets were deployed.",
        tags: ["auth"],
        updated_at: "2026-04-06T01:00:00.000Z",
        accessed_at: "2026-04-06T01:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "auth-3",
        title: "Auth Recovery",
        content: "Auth recovered after secrets rotation and smoke tests.",
        tags: ["auth"],
        updated_at: "2026-04-06T02:00:00.000Z",
        accessed_at: "2026-04-06T02:00:00.000Z"
      })
    );

    const result = await synthesisEngine.synthesize("auth", "vega");
    const page = pageManager.getPage(result.page_id);

    assert.equal(result.action, "created");
    assert.ok(page);
    assert.match(page.content, /## Key Notes/);
    assert.match(page.content, /Auth Rollout/);
    assert.match(page.content, /Sources/);
  } finally {
    globalThis.fetch = originalFetch;
    repository.close();
  }
});

test("synthesize returns unchanged when fewer than 3 memories", async () => {
  const mock = installOllamaMock();
  const { repository, pageManager, synthesisEngine } = createHarness();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        title: "Auth note",
        content: "Auth topic has a single memory.",
        tags: ["auth"]
      })
    );

    const result = await synthesisEngine.synthesize("auth", "vega");

    assert.deepEqual(result, {
      page_id: "",
      slug: "",
      action: "unchanged",
      memories_used: 0
    });
    assert.equal(pageManager.listPages({ limit: 10 }).length, 0);
  } finally {
    mock.restore();
    repository.close();
  }
});

test("synthesize with force=true works with fewer memories", async () => {
  const mock = installOllamaMock();
  const { repository, pageManager, synthesisEngine } = createHarness();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        title: "Auth note",
        content: "Auth topic has a single memory.",
        tags: ["auth"]
      })
    );

    const result = await synthesisEngine.synthesize("auth", "vega", true);
    const page = pageManager.getPage(result.page_id);

    assert.equal(result.action, "created");
    assert.equal(result.memories_used, 1);
    assert.ok(page);
    assert.equal(page.slug, "auth");
  } finally {
    mock.restore();
    repository.close();
  }
});

test("synthesize updates existing page", async () => {
  const mock = installOllamaMock([
    "## Synthesized Content\n\nInitial synthesis.",
    "## Synthesized Content\n\nUpdated synthesis."
  ]);
  const { repository, pageManager, synthesisEngine } = createHarness();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        title: "Auth setup",
        content: "Auth uses token refresh for wiki synthesis.",
        tags: ["auth"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-2",
        title: "Auth deploy",
        content: "Auth deploy needs a smoke test.",
        tags: ["auth"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-3",
        title: "Auth tests",
        content: "Auth tests found a stale session bug.",
        tags: ["auth"]
      })
    );

    const created = await synthesisEngine.synthesize("auth", "vega");
    repository.createMemory(
      createStoredMemory({
        id: "memory-4",
        title: "Auth metrics",
        content: "Auth metrics now log token refresh latency.",
        tags: ["auth"],
        updated_at: "2026-04-06T01:00:00.000Z",
        accessed_at: "2026-04-06T01:00:00.000Z"
      })
    );

    const updated = await synthesisEngine.synthesize("auth", "vega");
    const page = pageManager.getPage(updated.page_id);
    const versions = pageManager.getVersions(updated.page_id);

    assert.equal(created.action, "created");
    assert.equal(updated.action, "updated");
    assert.ok(page);
    assert.equal(page.version, 2);
    assert.equal(page.summary, "Updated synthesis.");
    assert.deepEqual(page.source_memory_ids.sort(), ["memory-1", "memory-2", "memory-3", "memory-4"]);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].change_reason, "Synthesis update: 1 new memories");
    assert.ok(
      mock.chatRequests[1]?.messages[1]?.content.includes(
        "Existing page content (integrate new memories into this):"
      )
    );
  } finally {
    mock.restore();
    repository.close();
  }
});

test("findSynthesisCandidates groups by tag", async () => {
  const { repository, synthesisEngine } = createHarness();

  try {
    repository.createMemory(createStoredMemory({ id: "memory-1", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "memory-2", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "memory-3", tags: ["auth"] }));
    repository.createMemory(createStoredMemory({ id: "memory-4", tags: ["cache"] }));
    repository.createMemory(createStoredMemory({ id: "memory-5", tags: ["cache"] }));
    repository.createMemory(createStoredMemory({ id: "memory-6", tags: ["cache"] }));
    repository.createMemory(createStoredMemory({ id: "memory-7", tags: ["cache"] }));

    const candidates = await synthesisEngine.findSynthesisCandidates("vega");

    assert.deepEqual(candidates, [
      {
        topic: "cache",
        memory_count: 4,
        memory_ids: ["memory-4", "memory-5", "memory-6", "memory-7"]
      },
      {
        topic: "auth",
        memory_count: 3,
        memory_ids: ["memory-1", "memory-2", "memory-3"]
      }
    ]);
  } finally {
    repository.close();
  }
});

test("synthesizeAll processes all candidates", async () => {
  const mock = installOllamaMock();
  const { repository, pageManager, synthesisEngine } = createHarness();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        title: "Auth setup",
        content: "Auth tokens rotate every 24 hours.",
        tags: ["auth"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-2",
        title: "Auth tests",
        content: "Auth tests cover session expiry.",
        tags: ["auth"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-3",
        title: "Auth deploy",
        content: "Auth deploy requires secret sync.",
        tags: ["auth"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-4",
        title: "Cache setup",
        content: "Cache uses a 5 minute TTL.",
        tags: ["cache"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-5",
        title: "Cache warmup",
        content: "Cache warmup runs before traffic cutover.",
        tags: ["cache"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-6",
        title: "Cache eviction",
        content: "Cache eviction clears stale index entries.",
        tags: ["cache"]
      })
    );

    const results = await synthesisEngine.synthesizeAll("vega");
    const pages = pageManager.listPages({ project: "vega", limit: 10, sort: "created_at ASC" });

    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((result) => result.action),
      ["created", "created"]
    );
    assert.deepEqual(
      pages.map((page) => page.slug),
      ["auth", "cache"]
    );
  } finally {
    mock.restore();
    repository.close();
  }
});

test("page_type is inferred from memory types", async () => {
  const mock = installOllamaMock();
  const { repository, pageManager, synthesisEngine } = createHarness();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        type: "pitfall",
        title: "Auth failure 1",
        content: "Auth failed after token expiry.",
        tags: ["auth"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-2",
        type: "pitfall",
        title: "Auth failure 2",
        content: "Auth failed when refresh headers were missing.",
        tags: ["auth"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-3",
        type: "pitfall",
        title: "Auth failure 3",
        content: "Auth failed during deploy due to stale secrets.",
        tags: ["auth"]
      })
    );

    const result = await synthesisEngine.synthesize("auth", "vega");
    const page = pageManager.getPage(result.page_id);

    assert.ok(page);
    assert.equal(page.page_type, "pitfall_guide");
  } finally {
    mock.restore();
    repository.close();
  }
});
