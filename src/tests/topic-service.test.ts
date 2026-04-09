import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { TopicService } from "../core/topic-service.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";

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

const createStoredMemory = (
  id: string,
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id,
  tenant_id: null,
  type: "decision",
  project: "vega",
  title: `Memory ${id}`,
  content: `Stored content for ${id}`,
  summary: null,
  embedding: null,
  importance: 0.5,
  source: "explicit",
  tags: ["topic"],
  created_at: "2026-04-09T00:00:00.000Z",
  updated_at: "2026-04-09T00:00:00.000Z",
  accessed_at: "2026-04-09T00:00:00.000Z",
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const parseAuditDetail = (detail: string): Record<string, unknown> =>
  JSON.parse(detail) as Record<string, unknown>;

test("overrideTopic creates a new active version and supersedes old topic assignments", async () => {
  const repository = new Repository(":memory:");
  const topicService = new TopicService(repository, baseConfig);

  try {
    repository.createMemory(createStoredMemory("memory-a"));
    repository.createMemory(createStoredMemory("memory-b"));
    await topicService.assignTopic("memory-a", "database", "auto");
    await topicService.assignTopic("memory-b", "database", "auto");

    const result = await topicService.overrideTopic(
      "vega",
      "database",
      "Database Core",
      "Canonical database taxonomy",
      { actor: "cli", ip: null }
    );
    const versions = topicService.listTopicVersions("vega", "database");
    const latest = repository.getActiveTopic("vega", "database");
    const oldAssignments = repository.listMemoryTopicsByTopicId(result.previous_topic_id as string);
    const newAssignments = repository.listMemoryTopicsByTopicId(result.topic.id, "active");
    const auditEntries = repository.getAuditLog({ action: "topic_override" });
    const auditDetail = parseAuditDetail(auditEntries[0]?.detail ?? "{}");

    assert.ok(latest);
    assert.equal(result.topic.version, 2);
    assert.equal(result.topic.label, "Database Core");
    assert.equal(result.topic.source, "explicit");
    assert.equal(result.reassigned_memory_count, 2);
    assert.equal(latest?.id, result.topic.id);
    assert.deepEqual(
      versions.map((topic) => ({ version: topic.version, state: topic.state })),
      [
        { version: 2, state: "active" },
        { version: 1, state: "superseded" }
      ]
    );
    assert.ok(oldAssignments.every((assignment) => assignment.status === "superseded"));
    assert.equal(newAssignments.length, 2);
    assert.deepEqual(repository.listMemoryIdsByTopic("vega", "database").sort(), ["memory-a", "memory-b"]);
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0]?.actor, "cli");
    assert.equal(auditDetail.new_version, 2);
    assert.equal(auditDetail.reassigned_memory_count, 2);
  } finally {
    repository.close();
  }
});

test("revertTopic materializes a new active head copied from a historical version", async () => {
  const repository = new Repository(":memory:");
  const topicService = new TopicService(repository, baseConfig);

  try {
    repository.createMemory(createStoredMemory("memory-a"));
    await topicService.assignTopic("memory-a", "database", "auto");
    await topicService.overrideTopic("vega", "database", "Database Core", "v2 label");

    const result = await topicService.revertTopic("vega", "database", 1, {
      actor: "mcp",
      ip: null
    });
    const versions = topicService.listTopicVersions("vega", "database");
    const auditEntries = repository.getAuditLog({ action: "topic_revert" });
    const auditDetail = parseAuditDetail(auditEntries[0]?.detail ?? "{}");

    assert.equal(result.topic.version, 3);
    assert.equal(result.topic.label, "Database");
    assert.equal(result.topic.source, "explicit");
    assert.deepEqual(
      versions.map((topic) => ({
        version: topic.version,
        label: topic.label,
        state: topic.state
      })),
      [
        { version: 3, label: "Database", state: "active" },
        { version: 2, label: "Database Core", state: "superseded" },
        { version: 1, label: "Database", state: "superseded" }
      ]
    );
    assert.deepEqual(repository.listMemoryIdsByTopic("vega", "database"), ["memory-a"]);
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0]?.actor, "mcp");
    assert.equal(auditDetail.target_version, 1);
    assert.equal(auditDetail.new_version, 3);
  } finally {
    repository.close();
  }
});

test("reassignMemoryTopic supersedes the old link, activates the new link, and audits the change", async () => {
  const repository = new Repository(":memory:");
  const topicService = new TopicService(repository, baseConfig);

  try {
    repository.createMemory(createStoredMemory("memory-a"));
    await topicService.assignTopic("memory-a", "database", "auto");

    const result = await topicService.reassignMemoryTopic(
      "memory-a",
      "database",
      "auth.login",
      { actor: "cli", ip: null }
    );
    const oldTopic = repository.getTopicVersion("vega", "database", 1);
    const newTopic = repository.getActiveTopic("vega", "auth.login");
    const oldAssignment = repository.getMemoryTopic("memory-a", result.from_topic_id);
    const newAssignment = repository.getMemoryTopic("memory-a", result.to_topic_id);
    const auditEntries = repository.getAuditLog({ action: "topic_reassign", memory_id: "memory-a" });
    const auditDetail = parseAuditDetail(auditEntries[0]?.detail ?? "{}");

    assert.ok(oldTopic);
    assert.ok(newTopic);
    assert.equal(result.project, "vega");
    assert.equal(result.to_topic_created, true);
    assert.equal(oldAssignment?.status, "superseded");
    assert.equal(newAssignment?.status, "active");
    assert.equal(newAssignment?.source, "explicit");
    assert.deepEqual(repository.listMemoryIdsByTopic("vega", "database"), []);
    assert.deepEqual(repository.listMemoryIdsByTopic("vega", "auth.login"), ["memory-a"]);
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0]?.actor, "cli");
    assert.equal(auditDetail.from_topic_key, "database");
    assert.equal(auditDetail.to_topic_key, "auth.login");
  } finally {
    repository.close();
  }
});
