import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { exportSnapshot } from "../core/snapshot.js";
import type { Memory, SearchOptions } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
};

const createEmbeddingBuffer = (values: number[]): Buffer => Buffer.from(new Float32Array(values).buffer);

const createStoredMemory = (overrides: Partial<Omit<Memory, "access_count">> = {}): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  type: "decision",
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
  ...overrides
});

const defaultSearchOptions: SearchOptions = {
  project: "vega",
  limit: 10,
  minSimilarity: 0
};

const installEmbeddingMock = (vector: number[]): (() => void) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST") {
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

    return new Response(JSON.stringify({ version: "mock" }), { status: 200 });
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
};

test("store creates memory with correct defaults", async () => {
  const restoreFetch = installEmbeddingMock([0.2, 0.8]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const result = await service.store({
      content: "Use better-sqlite3 for durable local storage",
      type: "decision",
      project: "vega"
    });

    const stored = repository.getMemory(result.id);

    assert.equal(result.action, "created");
    assert.ok(stored);
    assert.equal(stored.verified, "unverified");
    assert.equal(stored.importance, 0.5);
    assert.equal(stored.scope, "project");
    assert.deepEqual(stored.tags, ["better", "sqlite3", "durable", "local", "storage"]);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("store with explicit source sets verified and applies importance bonus", async () => {
  const restoreFetch = installEmbeddingMock([0.3, 0.7]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const result = await service.store({
      content: "The user explicitly prefers concise output",
      type: "insight",
      project: "vega",
      source: "explicit"
    });

    const stored = repository.getMemory(result.id);

    assert.ok(stored);
    assert.equal(stored.verified, "verified");
    assert.equal(stored.importance, 0.85);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("store preference type sets scope to global", async () => {
  const restoreFetch = installEmbeddingMock([0.5, 0.5]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const result = await service.store({
      content: "Always show costs in USD",
      type: "preference",
      project: "vega"
    });

    const stored = repository.getMemory(result.id);

    assert.ok(stored);
    assert.equal(stored.scope, "global");
    assert.equal(stored.importance, 0.95);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("store dedup updates existing memory when embeddings match", async () => {
  const restoreFetch = installEmbeddingMock([1, 0]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const first = await service.store({
      content: "Remember the deployment checklist before release",
      type: "project_context",
      project: "vega"
    });
    const second = await service.store({
      content: "Deployment checklist includes smoke tests before release",
      type: "project_context",
      project: "vega"
    });

    const memories = repository.listMemories({ project: "vega", type: "project_context", limit: 10 });
    const stored = repository.getMemory(first.id);

    assert.equal(second.action, "updated");
    assert.equal(second.id, first.id);
    assert.equal(memories.length, 1);
    assert.ok(stored);
    assert.match(stored.content, /Remember the deployment checklist/i);
    assert.match(stored.content, /smoke tests/i);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("recall returns results and updates access metadata", async () => {
  const restoreFetch = installEmbeddingMock([0.9, 0.1]);
  const repository = new Repository(":memory:");
  const searchEngine = new SearchEngine(repository, baseConfig);
  const service = new RecallService(repository, searchEngine, baseConfig);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-recall",
        title: "SQLite Decision",
        content: "SQLite stores the Vega memory index locally.",
        tags: ["sqlite", "index"]
      })
    );

    const results = await service.recall("SQLite", defaultSearchOptions);
    const stored = repository.getMemory("memory-recall");
    const versions = repository.getVersions("memory-recall");

    assert.equal(results.length, 1);
    assert.equal(results[0]?.memory.id, "memory-recall");
    assert.ok(stored);
    assert.equal(stored.access_count, 1);
    assert.deepEqual(stored.accessed_projects, ["vega"]);
    assert.equal(versions.length, 0);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("listMemories filters by type", () => {
  const repository = new Repository(":memory:");
  const searchEngine = new SearchEngine(repository, baseConfig);
  const service = new RecallService(repository, searchEngine, baseConfig);

  try {
    repository.createMemory(createStoredMemory({ id: "decision-1", type: "decision" }));
    repository.createMemory(createStoredMemory({ id: "insight-1", type: "insight", title: "Insight" }));

    const memories = service.listMemories({ project: "vega", type: "insight", limit: 10 });

    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.id, "insight-1");
  } finally {
    repository.close();
  }
});

test("compact archives low importance memories", () => {
  const repository = new Repository(":memory:");
  const service = new CompactService(repository, baseConfig);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "low-importance",
        title: "Low Importance",
        importance: 0.05
      })
    );

    const result = service.compact("vega");
    const stored = repository.getMemory("low-importance");

    assert.equal(result.merged, 0);
    assert.equal(result.archived, 1);
    assert.ok(stored);
    assert.equal(stored.status, "archived");
  } finally {
    repository.close();
  }
});

test("compact does not merge memories across different types", () => {
  const repository = new Repository(":memory:");
  const service = new CompactService(repository, baseConfig);
  const sharedEmbedding = createEmbeddingBuffer([1, 0]);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "decision-merge-candidate",
        type: "decision",
        title: "Decision candidate",
        content: "Choose SQLite for storage.",
        embedding: sharedEmbedding
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "pitfall-merge-candidate",
        type: "pitfall",
        title: "Pitfall candidate",
        content: "SQLite WAL backups need checkpointing.",
        embedding: sharedEmbedding
      })
    );

    const result = service.compact("vega");
    const activeMemories = repository.listMemories({
      project: "vega",
      status: "active",
      limit: 10
    });

    assert.equal(result.merged, 0);
    assert.equal(result.archived, 0);
    assert.deepEqual(
      activeMemories.map((memory) => memory.id).sort(),
      ["decision-merge-candidate", "pitfall-merge-candidate"]
    );
  } finally {
    repository.close();
  }
});

test("compact clears the surviving embedding after a merge", () => {
  const repository = new Repository(":memory:");
  const service = new CompactService(repository, baseConfig);
  const olderTimestamp = "2026-04-01T00:00:00.000Z";
  const newerTimestamp = "2026-04-02T00:00:00.000Z";

  try {
    repository.createMemory(
      createStoredMemory({
        id: "duplicate-older",
        type: "decision",
        title: "Older duplicate",
        content: "Use SQLite.",
        embedding: createEmbeddingBuffer([1, 0]),
        updated_at: olderTimestamp
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "duplicate-newer",
        type: "decision",
        title: "Newer duplicate",
        content: "Use SQLite with FTS5.",
        embedding: createEmbeddingBuffer([1, 0]),
        updated_at: newerTimestamp
      })
    );

    const result = service.compact("vega");
    const survivor = repository.getMemory("duplicate-newer");
    const archived = repository.getMemory("duplicate-older");

    assert.equal(result.merged, 1);
    assert.ok(survivor);
    assert.equal(survivor.embedding, null);
    assert.match(survivor.content, /Use SQLite\./);
    assert.match(survivor.content, /FTS5/);
    assert.ok(archived);
    assert.equal(archived.status, "archived");
  } finally {
    repository.close();
  }
});

test("store deduplicates global preferences across projects", async () => {
  const restoreFetch = installEmbeddingMock([0.7, 0.3]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const first = await service.store({
      content: "Always keep responses concise.",
      type: "preference",
      project: "project-a"
    });
    const second = await service.store({
      content: "Always keep responses concise.",
      type: "preference",
      project: "project-b"
    });

    const preferences = repository.listMemories({
      type: "preference",
      scope: "global",
      limit: 10
    });
    const stored = repository.getMemory(first.id);

    assert.equal(first.action, "created");
    assert.equal(second.action, "updated");
    assert.equal(second.id, first.id);
    assert.equal(preferences.length, 1);
    assert.ok(stored);
    assert.deepEqual(stored.accessed_projects.sort(), ["project-a", "project-b"]);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("exportSnapshot writes markdown output", () => {
  const repository = new Repository(":memory:");
  const tempDir = mkdtempSync(join(tmpdir(), "vega-snapshot-"));
  const outputPath = join(tempDir, "snapshot.md");

  try {
    repository.createMemory(
      createStoredMemory({
        id: "snapshot-1",
        type: "decision",
        title: "SQLite Decision",
        content: "Use SQLite and FTS5 for local search."
      })
    );

    exportSnapshot(repository, outputPath);

    const content = readFileSync(outputPath, "utf8");

    assert.match(content, /^# Memory Snapshot/m);
    assert.match(content, /^## decision/m);
    assert.match(content, /^### SQLite Decision/m);
    assert.match(content, /Use SQLite and FTS5 for local search\./);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("delete removes memory", async () => {
  const restoreFetch = installEmbeddingMock([0.4, 0.6]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const result = await service.store({
      content: "Delete this temporary memory",
      type: "insight",
      project: "vega"
    });

    await service.delete(result.id);

    assert.equal(repository.getMemory(result.id), null);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("exportSnapshot creates the output file", () => {
  const repository = new Repository(":memory:");
  const tempDir = mkdtempSync(join(tmpdir(), "vega-snapshot-file-"));
  const outputPath = join(tempDir, "snapshot.md");

  try {
    exportSnapshot(repository, outputPath);

    assert.equal(existsSync(outputPath), true);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
