import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { ArchiveService } from "../core/archive-service.js";
import { getHealthReport } from "../core/health.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { embeddingCache } from "../embedding/cache.js";
import { SearchEngine } from "../search/engine.js";

interface TestHarness {
  baseUrl: string;
  repository: Repository;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const createHarness = async (overrides: Partial<VegaConfig> = {}): Promise<TestHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-archive-api-"));
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
    ...overrides
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

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://mock-ollama.local",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  archiveMaxSizeMb: 500,
  apiPort: 0,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: ":memory:",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  dbEncryption: false
};

const installFetchMock = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): (() => void) => {
  const originalFetch = globalThis.fetch;
  embeddingCache.clear();

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;

  return () => {
    embeddingCache.clear();
    globalThis.fetch = originalFetch;
  };
};

test("ArchiveService stores and retrieves raw archives", () => {
  const repository = new Repository(":memory:");
  const archiveService = new ArchiveService(repository);

  try {
    const stored = archiveService.store(
      "Transcript line one\nTranscript line two",
      "transcript",
      "vega",
      {
        title: "Session transcript",
        source_uri: "session://abc",
        metadata: {
          speaker: "agent"
        },
        captured_at: "2026-04-09T00:00:00.000Z"
      }
    );
    const archive = archiveService.retrieve(stored.id);

    assert.equal(stored.created, true);
    assert.ok(archive);
    assert.equal(archive.archive_type, "transcript");
    assert.equal(archive.title, "Session transcript");
    assert.equal(archive.source_uri, "session://abc");
    assert.equal(archive.content, "Transcript line one\nTranscript line two");
    assert.deepEqual(archive.metadata, {
      speaker: "agent"
    });
    assert.equal(archive.captured_at, "2026-04-09T00:00:00.000Z");
  } finally {
    repository.close();
  }
});

test("ArchiveService dedupes by tenant and content hash", () => {
  const repository = new Repository(":memory:");
  const archiveService = new ArchiveService(repository);

  try {
    const first = archiveService.store("Same exported chat", "chat_export", "vega", {
      tenant_id: "tenant-a"
    });
    const duplicate = archiveService.store("Same exported chat", "chat_export", "vega", {
      tenant_id: "tenant-a"
    });
    const otherTenant = archiveService.store("Same exported chat", "chat_export", "vega", {
      tenant_id: "tenant-b"
    });

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.id, first.id);
    assert.notEqual(otherTenant.id, first.id);
    assert.equal(
      repository.listRawArchives("vega", "chat_export", 10).length,
      2
    );
  } finally {
    repository.close();
  }
});

test("ArchiveService search uses BM25 over raw archive content", () => {
  const repository = new Repository(":memory:");
  const archiveService = new ArchiveService(repository);

  try {
    archiveService.store(
      "Enable WAL mode before running SQLite backup verification.",
      "document",
      "vega",
      {
        title: "SQLite backup runbook"
      }
    );
    archiveService.store(
      "Redis cache invalidation steps for background jobs.",
      "document",
      "vega",
      {
        title: "Redis runbook"
      }
    );

    const results = archiveService.search("WAL", "vega", 5);

    assert.equal(results.length, 1);
    assert.equal(results[0]?.archive.title, "SQLite backup runbook");
    assert.equal(typeof results[0]?.rank, "number");
  } finally {
    repository.close();
  }
});

test("ArchiveService.store defers embeddings to the background builder", async () => {
  let postCalls = 0;
  const restoreFetch = installFetchMock((_url, init) => {
    if ((init?.method ?? "GET") !== "POST") {
      return new Response(JSON.stringify({ version: "mock" }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    postCalls += 1;

    return new Response(
      JSON.stringify({
        embeddings: [[0.1, 0.2, 0.3]]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  });
  const repository = new Repository(":memory:");
  const archiveService = new ArchiveService(repository, baseConfig);

  try {
    archiveService.store("Cold archive writes must not call Ollama.", "document", "vega");
    const beforeStats = archiveService.getStats();

    assert.equal(postCalls, 0);

    const result = await archiveService.buildEmbeddings(10);
    const afterStats = archiveService.getStats();

    assert.equal(postCalls, 1);
    assert.equal(beforeStats.with_embedding_count, 0);
    assert.equal(beforeStats.without_embedding_count, 1);
    assert.equal(result.embedded, 1);
    assert.equal(result.skipped, 0);
    assert.equal(afterStats.with_embedding_count, 1);
    assert.equal(afterStats.without_embedding_count, 0);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("ArchiveService.buildEmbeddings populates deferred archive embeddings", async () => {
  const restoreFetch = installFetchMock((_url, init) => {
    if ((init?.method ?? "GET") !== "POST") {
      return new Response(JSON.stringify({ version: "mock" }), { status: 200 });
    }

    return new Response(
      JSON.stringify({
        embeddings: [[0.25, 0.75, 0.5]]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  });
  const repository = new Repository(":memory:");
  const archiveService = new ArchiveService(repository, baseConfig);

  try {
    archiveService.store("First cold archive document.", "document", "vega");
    archiveService.store("Second cold archive document.", "document", "vega");

    const result = await archiveService.buildEmbeddings(10, "vega");
    const stats = archiveService.getStats("vega");

    assert.equal(result.processed, 2);
    assert.equal(result.embedded, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.remaining_without_embedding, 0);
    assert.equal(stats.with_embedding_count, 2);
    assert.equal(stats.without_embedding_count, 0);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("ArchiveService.repairHashes backfills missing hashes and flags legacy duplicates", () => {
  const repository = new Repository(":memory:");
  const archiveService = new ArchiveService(repository, baseConfig);

  try {
    repository.db.exec("DROP INDEX IF EXISTS idx_raw_archives_dedupe");

    repository.createRawArchive({
      id: "legacy-1",
      tenant_id: null,
      project: "vega",
      source_memory_id: null,
      archive_type: "document",
      title: "Legacy archive 1",
      source_uri: null,
      content: "Legacy duplicate content",
      content_hash: "",
      metadata: {},
      captured_at: null,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z"
    });
    repository.createRawArchive({
      id: "legacy-2",
      tenant_id: null,
      project: "vega",
      source_memory_id: null,
      archive_type: "document",
      title: "Legacy archive 2",
      source_uri: null,
      content: "Legacy duplicate content",
      content_hash: "",
      metadata: {},
      captured_at: null,
      created_at: "2026-04-01T00:00:01.000Z",
      updated_at: "2026-04-01T00:00:01.000Z"
    });

    const repair = archiveService.repairHashes(10, "vega");
    const stats = archiveService.getStats("vega");

    assert.equal(repair.scanned, 2);
    assert.equal(repair.updated, 1);
    assert.equal(repair.duplicates.length, 1);
    assert.equal(repair.duplicates[0]?.id, "legacy-2");
    assert.notEqual(repository.getRawArchive("legacy-1")?.content_hash, "");
    assert.equal(repository.getRawArchive("legacy-2")?.content_hash, "");
    assert.equal(stats.missing_hash_count, 1);
  } finally {
    repository.close();
  }
});

test("health report warns when cold archive size exceeds the configured threshold", async () => {
  const restoreFetch = installFetchMock(() =>
    new Response(JSON.stringify({ version: "mock" }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    })
  );
  const repository = new Repository(":memory:");
  const archiveService = new ArchiveService(repository, {
    ...baseConfig,
    archiveMaxSizeMb: 0.0001
  });

  try {
    archiveService.store("X".repeat(1024), "document", "vega");

    const report = await getHealthReport(repository, {
      ...baseConfig,
      archiveMaxSizeMb: 0.0001
    });

    assert.equal(report.status, "degraded");
    assert.match(report.issues.join("\n"), /Cold archive size/);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("POST /api/deep-recall returns redacted archive evidence by default", async () => {
  const harness = await createHarness();

  try {
    const storeResponse = await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "SQLite backup evidence password=cleartext should stay cold-only.",
        type: "pitfall",
        project: "vega"
      })
    });
    const stored = await readJson<{ id: string; action: string }>(storeResponse);
    const hotMemory = harness.repository.getMemory(stored.id);

    assert.equal(storeResponse.status, 200);
    assert.ok(hotMemory);
    assert.match(hotMemory.content, /\[REDACTED:SECRET\]/);

    const response = await harness.request("/api/deep-recall", {
      method: "POST",
      body: JSON.stringify({
        query: "SQLite backup evidence",
        project: "vega",
        include_content: true,
        include_metadata: true
      })
    });
    const body = await readJson<{
      results: Array<{
        archive_id: string;
        memory_id: string | null;
        archive_type: string;
        title: string;
        content?: string;
        contains_raw: boolean;
        metadata?: Record<string, unknown>;
      }>;
      next_cursor: string | null;
      injected_into_session: boolean;
      warnings?: string[];
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.next_cursor, null);
    assert.equal(body.injected_into_session, false);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0]?.memory_id, stored.id);
    assert.equal(body.results[0]?.archive_type, "document");
    assert.match(body.results[0]?.content ?? "", /\[REDACTED:SECRET\]/);
    assert.equal(body.results[0]?.contains_raw, false);
    assert.deepEqual(body.results[0]?.metadata, {
      captured_from: "memory_service",
      memory_type: "pitfall",
      contains_raw: false
    });
    assert.equal(body.warnings, undefined);
  } finally {
    await harness.cleanup();
  }
});

test("POST /api/store with preserve_raw keeps raw archive evidence and warns on deep recall", async () => {
  const harness = await createHarness();

  try {
    const storeResponse = await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "SQLite backup evidence password=cleartext should stay cold-only.",
        type: "pitfall",
        project: "vega",
        preserve_raw: true
      })
    });
    const stored = await readJson<{ id: string; action: string }>(storeResponse);
    const hotMemory = harness.repository.getMemory(stored.id);
    const rawAuditEntries = harness.repository.getAuditLog({
      action: "raw_archive_preserved",
      memory_id: stored.id
    });

    assert.equal(storeResponse.status, 200);
    assert.ok(hotMemory);
    assert.match(hotMemory.content, /\[REDACTED:SECRET\]/);
    assert.equal(rawAuditEntries.length, 1);

    const response = await harness.request("/api/deep-recall", {
      method: "POST",
      body: JSON.stringify({
        query: "cleartext",
        project: "vega",
        include_content: true,
        include_metadata: true
      })
    });
    const body = await readJson<{
      results: Array<{
        archive_id: string;
        memory_id: string | null;
        archive_type: string;
        title: string;
        content?: string;
        contains_raw: boolean;
        metadata?: Record<string, unknown>;
      }>;
      next_cursor: string | null;
      injected_into_session: boolean;
      warnings?: string[];
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0]?.memory_id, stored.id);
    assert.match(body.results[0]?.content ?? "", /password=cleartext/);
    assert.equal(body.results[0]?.contains_raw, true);
    assert.deepEqual(body.results[0]?.metadata, {
      captured_from: "memory_service",
      memory_type: "pitfall",
      contains_raw: true
    });
    assert.deepEqual(body.warnings, [
      "deep_recall returned raw archived content; treat the result as sensitive evidence."
    ]);
  } finally {
    await harness.cleanup();
  }
});

test("MemoryService skips raw archive capture when raw archive feature is disabled", async () => {
  const harness = await createHarness({
    features: {
      rawArchive: false
    }
  });

  try {
    const response = await harness.request("/api/store", {
      method: "POST",
      body: JSON.stringify({
        content: "Cold archive writes should stay disabled during rollback.",
        type: "insight",
        project: "vega"
      })
    });
    const body = await readJson<{ id: string; action: string }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.action, "created");
    assert.equal(harness.repository.listRawArchives("vega").length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("POST /api/deep-recall returns 501 when the feature is disabled", async () => {
  const harness = await createHarness({
    features: {
      deepRecall: false
    }
  });

  try {
    const response = await harness.request("/api/deep-recall", {
      method: "POST",
      body: JSON.stringify({
        query: "backup evidence",
        project: "vega"
      })
    });
    const body = await readJson<{ error: string }>(response);

    assert.equal(response.status, 501);
    assert.equal(body.error, "deep_recall feature is disabled");
  } finally {
    await harness.cleanup();
  }
});
