import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { ArchiveService } from "../core/archive-service.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";

interface TestHarness {
  baseUrl: string;
  repository: Repository;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const createHarness = async (): Promise<TestHarness> => {
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
    dbEncryption: false
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

test("POST /api/deep-recall returns original unredacted archive evidence", async () => {
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
        metadata?: Record<string, unknown>;
      }>;
      next_cursor: string | null;
      injected_into_session: boolean;
    }>(response);

    assert.equal(response.status, 200);
    assert.equal(body.next_cursor, null);
    assert.equal(body.injected_into_session, false);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0]?.memory_id, stored.id);
    assert.equal(body.results[0]?.archive_type, "document");
    assert.match(body.results[0]?.content ?? "", /password=cleartext/);
    assert.deepEqual(body.results[0]?.metadata, {
      captured_from: "memory_service",
      memory_type: "pitfall"
    });
  } finally {
    await harness.cleanup();
  }
});
