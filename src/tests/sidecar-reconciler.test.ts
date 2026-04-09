import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { SidecarReconciler } from "../core/sidecar-reconciler.js";
import { TopicService } from "../core/topic-service.js";
import type { FactClaim, Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  dbEncryption: false,
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "test-model",
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
  telegramChatId: undefined,
  features: {
    factClaims: true,
    rawArchive: true,
    topicRecall: true,
    deepRecall: true
  }
};

const createEmbeddingBuffer = (values: number[]): Buffer =>
  Buffer.from(new Float32Array(values).buffer);

const createMemory = (
  id: string,
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => {
  const { summary = null, ...rest } = overrides;

  return {
    id,
    tenant_id: null,
    type: "decision",
    project: "vega",
    title: `Memory ${id}`,
    content: `Content for ${id}`,
    summary,
    embedding: null,
    importance: 0.5,
    source: "explicit",
    tags: ["sqlite"],
    created_at: "2026-04-09T00:00:00.000Z",
    updated_at: "2026-04-09T00:00:00.000Z",
    accessed_at: "2026-04-09T00:00:00.000Z",
    status: "active",
    verified: "verified",
    scope: "project",
    accessed_projects: ["vega"],
    ...rest
  };
};

const createFactClaim = (id: string, overrides: Partial<FactClaim> = {}): FactClaim => ({
  id,
  tenant_id: null,
  project: "vega",
  source_memory_id: "memory-1",
  evidence_archive_id: null,
  canonical_key: "vega\u0000database\u0000sqlite",
  subject: "vega",
  predicate: "database",
  claim_value: "sqlite",
  claim_text: "Vega uses SQLite.",
  source: "hot_memory",
  status: "active",
  confidence: 0.8,
  valid_from: "2026-04-09T00:00:00.000Z",
  valid_to: null,
  temporal_precision: "day",
  invalidation_reason: null,
  created_at: "2026-04-09T00:00:00.000Z",
  updated_at: "2026-04-09T00:00:00.000Z",
  ...overrides
});

test("SidecarReconciler.onMemoryMerged relinks claims and migrates topic assignments", async () => {
  const repository = new Repository(":memory:");
  const topicService = new TopicService(repository, baseConfig);
  const reconciler = new SidecarReconciler(repository, baseConfig);

  try {
    repository.createMemory(
      createMemory("kept", {
        content: "Use SQLite with FTS5."
      })
    );
    repository.createMemory(
      createMemory("merged", {
        content: "Use SQLite."
      })
    );
    await topicService.assignTopic("merged", "database", "auto");

    const mergedTopic = repository.listMemoryTopicsByMemoryId("merged", "active")[0];

    repository.createFactClaim(
      createFactClaim("claim-kept", {
        source_memory_id: "kept"
      })
    );
    repository.createFactClaim(
      createFactClaim("claim-duplicate", {
        source_memory_id: "merged"
      })
    );
    repository.createFactClaim(
      createFactClaim("claim-extra", {
        source_memory_id: "merged",
        canonical_key: "vega\u0000search\u0000fts5",
        predicate: "search",
        claim_value: "fts5",
        claim_text: "Vega uses FTS5."
      })
    );

    const result = reconciler.onMemoryMerged("kept", ["merged"], {
      actor: "compact",
      ip: null
    });
    const duplicate = repository.getFactClaim("claim-duplicate");
    const extra = repository.getFactClaim("claim-extra");

    assert.ok(mergedTopic);
    assert.equal(result.relinkedClaims, 2);
    assert.equal(result.suspectedClaims, 1);
    assert.equal(result.migratedTopics, 1);
    assert.ok(duplicate);
    assert.equal(duplicate.source_memory_id, "kept");
    assert.equal(duplicate.status, "suspected_expired");
    assert.ok(extra);
    assert.equal(extra.source_memory_id, "kept");
    assert.equal(extra.status, "active");
    assert.equal(repository.getMemoryTopic("merged", mergedTopic.topic_id)?.status, "superseded");
    assert.equal(repository.getMemoryTopic("kept", mergedTopic.topic_id)?.status, "active");
    assert.deepEqual(repository.listMemoryIdsByTopic("vega", "database"), ["kept"]);
    assert.equal(repository.getAuditLog({ action: "sidecar_memory_merged", memory_id: "kept" }).length, 1);
  } finally {
    repository.close();
  }
});

test("CompactService integrates sidecar reconciliation for merged and archived memories", async () => {
  const repository = new Repository(":memory:");
  const topicService = new TopicService(repository, baseConfig);
  const compactService = new CompactService(repository, baseConfig);

  try {
    repository.createMemory(
      createMemory("older", {
        content: "Use SQLite.",
        embedding: createEmbeddingBuffer([1, 0]),
        updated_at: "2026-04-01T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createMemory("newer", {
        content: "Use SQLite with FTS5.",
        embedding: createEmbeddingBuffer([1, 0]),
        updated_at: "2026-04-02T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createMemory("low-importance", {
        content: "Temporary cleanup note.",
        importance: 0.05
      })
    );
    await topicService.assignTopic("older", "database", "auto");
    await topicService.assignTopic("low-importance", "cleanup", "auto");

    const olderTopic = repository.listMemoryTopicsByMemoryId("older", "active")[0];
    const lowImportanceTopic = repository.listMemoryTopicsByMemoryId("low-importance", "active")[0];

    repository.createFactClaim(
      createFactClaim("claim-older", {
        source_memory_id: "older"
      })
    );
    repository.createFactClaim(
      createFactClaim("claim-low", {
        source_memory_id: "low-importance",
        canonical_key: "vega\u0000cleanup\u0000temporary",
        predicate: "cleanup",
        claim_value: "temporary",
        claim_text: "Cleanup note is temporary."
      })
    );

    const result = compactService.compact("vega", {
      actor: "compact",
      ip: null
    });

    assert.ok(olderTopic);
    assert.ok(lowImportanceTopic);
    assert.equal(result.merged, 1);
    assert.equal(result.archived, 2);
    assert.equal(repository.getMemory("older")?.status, "archived");
    assert.equal(repository.getMemory("low-importance")?.status, "archived");
    assert.equal(repository.getFactClaim("claim-older")?.source_memory_id, "newer");
    assert.equal(repository.getFactClaim("claim-older")?.status, "active");
    assert.equal(repository.getMemoryTopic("older", olderTopic.topic_id)?.status, "superseded");
    assert.equal(repository.getMemoryTopic("newer", olderTopic.topic_id)?.status, "active");
    assert.equal(repository.getFactClaim("claim-low")?.status, "suspected_expired");
    assert.equal(
      repository.getMemoryTopic("low-importance", lowImportanceTopic.topic_id)?.status,
      "superseded"
    );
  } finally {
    repository.close();
  }
});

test("MemoryService.delete preserves claim evidence and allows memory removal", async () => {
  const repository = new Repository(":memory:");
  const topicService = new TopicService(repository, baseConfig);
  const memoryService = new MemoryService(repository, baseConfig);

  try {
    repository.createMemory(
      createMemory("delete-me", {
        content: "Delete this memory after reconciliation."
      })
    );
    await topicService.assignTopic("delete-me", "scratch", "auto");
    repository.createFactClaim(
      createFactClaim("claim-delete", {
        source_memory_id: "delete-me",
        canonical_key: "vega\u0000scratch\u0000temporary",
        predicate: "scratch",
        claim_value: "temporary",
        claim_text: "Scratch note is temporary."
      })
    );

    await memoryService.delete("delete-me", {
      actor: "cli",
      ip: null
    });

    const deletedClaim = repository.getFactClaim("claim-delete");

    assert.equal(repository.getMemory("delete-me"), null);
    assert.ok(deletedClaim);
    assert.equal(deletedClaim.source_memory_id, null);
    assert.ok(deletedClaim.evidence_archive_id);
    assert.equal(deletedClaim.status, "suspected_expired");
    assert.equal(repository.getRawArchive(deletedClaim.evidence_archive_id as string)?.source_memory_id, null);
    assert.match(
      repository.getRawArchive(deletedClaim.evidence_archive_id as string)?.content ?? "",
      /Delete this memory/
    );
    assert.equal(repository.listMemoryTopicsByMemoryId("delete-me").length, 0);
    assert.equal(repository.getAuditLog({ action: "sidecar_memory_deleted", memory_id: "delete-me" }).length, 1);
  } finally {
    repository.close();
  }
});

test("SidecarReconciler.reconcileAll repairs archived-memory drift", async () => {
  const repository = new Repository(":memory:");
  const topicService = new TopicService(repository, baseConfig);
  const reconciler = new SidecarReconciler(repository, baseConfig);

  try {
    repository.createMemory(
      createMemory("survivor", {
        content: "Use SQLite with FTS5.\n\nUse SQLite."
      })
    );
    repository.createMemory(
      createMemory("merged-drift", {
        content: "Use SQLite.",
        status: "archived"
      })
    );
    repository.createMemory(
      createMemory("stale-archived", {
        content: "Stale cleanup note.",
        status: "archived"
      })
    );
    await topicService.assignTopic("merged-drift", "database", "auto");
    await topicService.assignTopic("stale-archived", "cleanup", "auto");

    const mergedDriftTopic = repository.listMemoryTopicsByMemoryId("merged-drift", "active")[0];
    const staleTopic = repository.listMemoryTopicsByMemoryId("stale-archived", "active")[0];

    repository.createFactClaim(
      createFactClaim("claim-drift", {
        source_memory_id: "merged-drift"
      })
    );
    repository.createFactClaim(
      createFactClaim("claim-stale", {
        source_memory_id: "stale-archived",
        canonical_key: "vega\u0000cleanup\u0000stale",
        predicate: "cleanup",
        claim_value: "stale",
        claim_text: "Cleanup note is stale."
      })
    );

    const result = reconciler.reconcileAll("vega", {
      actor: "cli",
      ip: null
    });

    assert.ok(mergedDriftTopic);
    assert.ok(staleTopic);
    assert.equal(result.mergedMemories, 1);
    assert.equal(repository.getFactClaim("claim-drift")?.source_memory_id, "survivor");
    assert.equal(repository.getFactClaim("claim-drift")?.status, "active");
    assert.equal(repository.getMemoryTopic("merged-drift", mergedDriftTopic.topic_id)?.status, "superseded");
    assert.equal(repository.getMemoryTopic("survivor", mergedDriftTopic.topic_id)?.status, "active");
    assert.equal(repository.getFactClaim("claim-stale")?.status, "suspected_expired");
    assert.equal(repository.getMemoryTopic("stale-archived", staleTopic.topic_id)?.status, "superseded");
    assert.equal(repository.getAuditLog({ action: "sidecar_reconcile_all" }).length, 1);
  } finally {
    repository.close();
  }
});
