import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { MemoryService } from "../core/memory.js";
import { Repository } from "../db/repository.js";
import { embeddingCache } from "../embedding/cache.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  dbEncryption: false,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
};

const installEmbeddingMock = (vector: number[]): (() => void) => {
  const originalFetch = globalThis.fetch;
  embeddingCache.clear();

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
    embeddingCache.clear();
    globalThis.fetch = originalFetch;
  };
};

const getAuditEntriesForMemory = (repository: Repository, memoryId: string) =>
  repository.getAuditLog({ memory_id: memoryId });

test("store from MCP records actor as mcp", async () => {
  const restoreFetch = installEmbeddingMock([0.2, 0.8]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const result = await service.store({
      content: "Track MCP-originated audit records.",
      type: "decision",
      project: "vega",
      auditContext: { actor: "mcp", ip: null }
    });
    const auditEntries = getAuditEntriesForMemory(repository, result.id);

    assert.equal(auditEntries.length, 2);
    assert.deepEqual(
      auditEntries.map(({ actor, ip }) => ({ actor, ip })),
      [
        { actor: "mcp", ip: null },
        { actor: "mcp", ip: null }
      ]
    );
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("store from API records actor and IP", async () => {
  const restoreFetch = installEmbeddingMock([0.3, 0.7]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const result = await service.store({
      content: "Capture API request metadata in the audit log.",
      type: "decision",
      project: "vega",
      auditContext: { actor: "api", ip: "192.168.1.10" }
    });
    const auditEntries = getAuditEntriesForMemory(repository, result.id);

    assert.equal(auditEntries.length, 2);
    assert.deepEqual(
      auditEntries.map(({ actor, ip }) => ({ actor, ip })),
      [
        { actor: "api", ip: "192.168.1.10" },
        { actor: "api", ip: "192.168.1.10" }
      ]
    );
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("store from CLI records actor as cli", async () => {
  const restoreFetch = installEmbeddingMock([0.4, 0.6]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const result = await service.store({
      content: "Persist CLI-originated memory writes.",
      type: "decision",
      project: "vega",
      auditContext: { actor: "cli", ip: null }
    });
    const auditEntries = getAuditEntriesForMemory(repository, result.id);

    assert.equal(auditEntries.length, 2);
    assert.ok(auditEntries.every((entry) => entry.actor === "cli"));
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("store without auditContext defaults to system", async () => {
  const restoreFetch = installEmbeddingMock([0.5, 0.5]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const result = await service.store({
      content: "Preserve backward-compatible audit defaults.",
      type: "decision",
      project: "vega"
    });
    const auditEntries = getAuditEntriesForMemory(repository, result.id);

    assert.equal(auditEntries.length, 2);
    assert.ok(auditEntries.every((entry) => entry.actor === "system" && entry.ip === null));
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("store with preserve_raw records a dedicated raw archive audit entry", async () => {
  const restoreFetch = installEmbeddingMock([0.4, 0.6]);
  const repository = new Repository(":memory:");
  const service = new MemoryService(repository, baseConfig);

  try {
    const result = await service.store({
      content: "Archive raw evidence token=super-secret for cold-only retention.",
      type: "pitfall",
      project: "vega",
      preserve_raw: true,
      auditContext: { actor: "api", ip: "192.168.1.20" }
    });
    const archive = repository.listRawArchives("vega")[0];
    const auditEntries = getAuditEntriesForMemory(repository, result.id);
    const rawAuditEntry = auditEntries.find((entry) => entry.action === "raw_archive_preserved");

    assert.equal(auditEntries.length, 3);
    assert.ok(archive);
    assert.ok(rawAuditEntry);
    assert.equal(rawAuditEntry.actor, "api");
    assert.equal(rawAuditEntry.ip, "192.168.1.20");
    assert.deepEqual(JSON.parse(rawAuditEntry.detail), {
      archive_id: archive.id,
      created: true,
      content_hash: archive.content_hash,
      memory_type: "pitfall",
      project: "vega",
      contains_raw: true
    });
  } finally {
    restoreFetch();
    repository.close();
  }
});
