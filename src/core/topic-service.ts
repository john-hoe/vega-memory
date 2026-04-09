import { v4 as uuidv4 } from "uuid";

import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import type { AuditContext, MemorySource, MemoryTopic, Topic } from "./types.js";

const now = (): string => new Date().toISOString();

const normalizeTopicKey = (topicKey: string): string => topicKey.trim().toLowerCase();

const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, " ");

const normalizeDescription = (description?: string): string | null => {
  const normalized = description?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
};

const inferTopicKind = (topicKey: string): Topic["kind"] =>
  topicKey.includes(".") ? "room" : "topic";

const labelFromTopicKey = (topicKey: string): string =>
  topicKey
    .split(".")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" / ");

const resolveAuditContext = (auditContext?: AuditContext): AuditContext => ({
  actor: auditContext?.actor ?? "system",
  ip: auditContext?.ip ?? null,
  tenant_id: auditContext?.tenant_id ?? null
});

const tokenize = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

const scoreTopic = (topic: Topic, tokens: Set<string>): number =>
  topic.topic_key
    .split(".")
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0)
    .reduce((score, segment) => score + (tokens.has(segment) ? 1 : 0), 0);

export interface TopicMutationResult {
  topic: Topic;
  previous_topic_id: string | null;
  previous_version: number | null;
  source_version: number;
  reassigned_memory_count: number;
}

export interface TopicReassignmentResult {
  memory_id: string;
  project: string;
  from_topic_id: string;
  to_topic_id: string;
  to_topic_created: boolean;
}

export class TopicService {
  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {}

  private ensureTopic(
    project: string,
    topicKey: string,
    source: MemorySource,
    tenantId?: string | null
  ): Topic {
    const normalizedTopicKey = normalizeTopicKey(topicKey);
    const existing = this.repository.getActiveTopic(project, normalizedTopicKey, tenantId);

    if (existing) {
      return existing;
    }

    const timestamp = now();
    const topic: Topic = {
      id: uuidv4(),
      tenant_id: tenantId ?? null,
      project,
      topic_key: normalizedTopicKey,
      version: 1,
      label: labelFromTopicKey(normalizedTopicKey),
      kind: inferTopicKind(normalizedTopicKey),
      description: null,
      source,
      state: "active",
      supersedes_topic_id: null,
      created_at: timestamp,
      updated_at: timestamp
    };

    this.repository.createTopic(topic);

    return topic;
  }

  private activateMemoryTopic(
    memoryId: string,
    topicId: string,
    source: MemoryTopic["source"],
    confidence: number | null,
    timestamp: string
  ): void {
    const existing = this.repository.getMemoryTopic(memoryId, topicId);

    if (existing) {
      this.repository.updateMemoryTopic(memoryId, topicId, {
        source,
        confidence,
        status: "active",
        updated_at: timestamp
      });
      return;
    }

    this.repository.createMemoryTopic({
      memory_id: memoryId,
      topic_id: topicId,
      source,
      confidence,
      status: "active",
      created_at: timestamp,
      updated_at: timestamp
    });
  }

  private mutateTopicHead(
    currentTopic: Topic,
    nextTopic: Topic,
    auditAction: "topic_override" | "topic_revert",
    detail: Record<string, unknown>,
    auditContext?: AuditContext
  ): TopicMutationResult {
    const timestamp = nextTopic.created_at;
    const activeAssignments = this.repository.listMemoryTopicsByTopicId(currentTopic.id, "active");
    const resolvedAuditContext = resolveAuditContext(auditContext);

    this.repository.db.transaction(() => {
      this.repository.updateTopicState(currentTopic.id, "superseded", timestamp);
      this.repository.createTopic(nextTopic);

      for (const assignment of activeAssignments) {
        this.repository.updateMemoryTopic(assignment.memory_id, assignment.topic_id, {
          status: "superseded",
          updated_at: timestamp
        });
        this.activateMemoryTopic(
          assignment.memory_id,
          nextTopic.id,
          assignment.source,
          assignment.confidence,
          timestamp
        );
      }

      this.repository.logAudit({
        timestamp,
        actor: resolvedAuditContext.actor,
        action: auditAction,
        memory_id: null,
        detail: JSON.stringify({
          ...detail,
          reassigned_memory_count: activeAssignments.length
        }),
        ip: resolvedAuditContext.ip,
        tenant_id: nextTopic.tenant_id ?? resolvedAuditContext.tenant_id ?? null
      });
    });

    return {
      topic: nextTopic,
      previous_topic_id: currentTopic.id,
      previous_version: currentTopic.version,
      source_version: detail.source_version as number,
      reassigned_memory_count: activeAssignments.length
    };
  }

  /** Attach an active topic assignment to a stored memory. */
  async assignTopic(
    memoryId: string,
    topicKey: string,
    source: MemorySource
  ): Promise<void> {
    const memory = this.repository.getMemory(memoryId);

    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    const topic = this.ensureTopic(memory.project, topicKey, source, memory.tenant_id ?? undefined);
    const timestamp = now();

    this.repository.db.transaction(() => {
      this.activateMemoryTopic(memoryId, topic.id, source, source === "explicit" ? null : 1, timestamp);
    });
  }

  /** Infer the best topic key for a memory payload. */
  async inferTopic(content: string, tags: string[], project: string): Promise<string | null> {
    void this.config;

    const topics = this.repository.listTopics(project);
    if (topics.length === 0) {
      return null;
    }

    const tokens = new Set<string>([...tokenize(content), ...tags.flatMap((tag) => tokenize(tag))]);
    let bestMatch: { topic_key: string; score: number } | null = null;

    for (const topic of topics) {
      const score = scoreTopic(topic, tokens);
      if (score === 0) {
        continue;
      }

      if (bestMatch === null || score > bestMatch.score) {
        bestMatch = {
          topic_key: topic.topic_key,
          score
        };
      }
    }

    return bestMatch?.topic_key ?? null;
  }

  /** List active taxonomy rows for a project. */
  listTopics(project: string): Topic[] {
    return this.repository.listTopics(project);
  }

  /** Replace the active topic definition with a new explicit version. */
  async overrideTopic(
    project: string,
    topicKey: string,
    newLabel: string,
    newDescription?: string,
    auditContext?: AuditContext
  ): Promise<TopicMutationResult> {
    const normalizedTopicKey = normalizeTopicKey(topicKey);
    const label = normalizeLabel(newLabel);

    if (normalizedTopicKey.length === 0) {
      throw new Error("Topic key must not be empty");
    }

    if (label.length === 0) {
      throw new Error("Topic label must not be empty");
    }

    const currentTopic = this.repository.getActiveTopic(project, normalizedTopicKey);
    if (!currentTopic) {
      throw new Error(`Active topic not found: ${project}:${normalizedTopicKey}`);
    }

    const versions = this.repository.listTopicVersions(project, normalizedTopicKey, currentTopic.tenant_id ?? undefined);
    const nextVersion = (versions[0]?.version ?? currentTopic.version) + 1;
    const timestamp = now();
    const nextTopic: Topic = {
      id: uuidv4(),
      tenant_id: currentTopic.tenant_id ?? null,
      project,
      topic_key: normalizedTopicKey,
      version: nextVersion,
      label,
      kind: currentTopic.kind,
      description: normalizeDescription(newDescription),
      source: "explicit",
      state: "active",
      supersedes_topic_id: currentTopic.id,
      created_at: timestamp,
      updated_at: timestamp
    };

    return this.mutateTopicHead(
      currentTopic,
      nextTopic,
      "topic_override",
      {
        project,
        topic_key: normalizedTopicKey,
        previous_version: currentTopic.version,
        new_version: nextVersion,
        previous_topic_id: currentTopic.id,
        new_topic_id: nextTopic.id,
        label,
        description: nextTopic.description,
        source_version: currentTopic.version
      },
      auditContext
    );
  }

  async revertTopic(
    project: string,
    topicKey: string,
    targetVersion: number,
    auditContext?: AuditContext
  ): Promise<TopicMutationResult> {
    const normalizedTopicKey = normalizeTopicKey(topicKey);

    if (!Number.isInteger(targetVersion) || targetVersion < 1) {
      throw new Error("Target version must be a positive integer");
    }

    const currentTopic = this.repository.getActiveTopic(project, normalizedTopicKey);
    if (!currentTopic) {
      throw new Error(`Active topic not found: ${project}:${normalizedTopicKey}`);
    }

    if (currentTopic.version === targetVersion) {
      return {
        topic: currentTopic,
        previous_topic_id: currentTopic.id,
        previous_version: currentTopic.version,
        source_version: targetVersion,
        reassigned_memory_count: 0
      };
    }

    const targetTopic = this.repository.getTopicVersion(
      project,
      normalizedTopicKey,
      targetVersion,
      currentTopic.tenant_id ?? undefined
    );

    if (!targetTopic) {
      throw new Error(`Topic version not found: ${project}:${normalizedTopicKey}@${targetVersion}`);
    }

    const versions = this.repository.listTopicVersions(project, normalizedTopicKey, currentTopic.tenant_id ?? undefined);
    const nextVersion = (versions[0]?.version ?? currentTopic.version) + 1;
    const timestamp = now();
    const nextTopic: Topic = {
      id: uuidv4(),
      tenant_id: currentTopic.tenant_id ?? null,
      project,
      topic_key: normalizedTopicKey,
      version: nextVersion,
      label: targetTopic.label,
      kind: targetTopic.kind,
      description: targetTopic.description,
      source: "explicit",
      state: "active",
      supersedes_topic_id: currentTopic.id,
      created_at: timestamp,
      updated_at: timestamp
    };

    return this.mutateTopicHead(
      currentTopic,
      nextTopic,
      "topic_revert",
      {
        project,
        topic_key: normalizedTopicKey,
        previous_version: currentTopic.version,
        target_version: targetVersion,
        new_version: nextVersion,
        previous_topic_id: currentTopic.id,
        target_topic_id: targetTopic.id,
        new_topic_id: nextTopic.id,
        label: targetTopic.label,
        description: targetTopic.description,
        source_version: targetVersion
      },
      auditContext
    );
  }

  listTopicVersions(project: string, topicKey: string): Topic[] {
    return this.repository.listTopicVersions(project, normalizeTopicKey(topicKey));
  }

  async reassignMemoryTopic(
    memoryId: string,
    fromTopicKey: string,
    toTopicKey: string,
    auditContext?: AuditContext
  ): Promise<TopicReassignmentResult> {
    const memory = this.repository.getMemory(memoryId);

    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    const normalizedFromTopicKey = normalizeTopicKey(fromTopicKey);
    const normalizedToTopicKey = normalizeTopicKey(toTopicKey);

    if (normalizedFromTopicKey.length === 0 || normalizedToTopicKey.length === 0) {
      throw new Error("Topic keys must not be empty");
    }

    if (normalizedFromTopicKey === normalizedToTopicKey) {
      throw new Error("From and to topic keys must differ");
    }

    const tenantId = memory.tenant_id ?? undefined;
    const fromTopic = this.repository.getActiveTopic(memory.project, normalizedFromTopicKey, tenantId);

    if (!fromTopic) {
      throw new Error(`Active topic not found: ${memory.project}:${normalizedFromTopicKey}`);
    }

    const fromAssignment = this.repository.getMemoryTopic(memoryId, fromTopic.id);
    if (!fromAssignment || fromAssignment.status !== "active") {
      throw new Error(`Active topic assignment not found: ${memoryId}:${normalizedFromTopicKey}`);
    }

    const timestamp = now();
    const resolvedAuditContext = resolveAuditContext(auditContext);
    let targetTopic = this.repository.getActiveTopic(memory.project, normalizedToTopicKey, tenantId);
    let toTopicCreated = false;

    this.repository.db.transaction(() => {
      if (!targetTopic) {
        targetTopic = this.ensureTopic(memory.project, normalizedToTopicKey, "explicit", tenantId);
        toTopicCreated = true;
      }

      this.repository.updateMemoryTopic(memoryId, fromTopic.id, {
        status: "superseded",
        updated_at: timestamp
      });
      this.activateMemoryTopic(memoryId, targetTopic.id, "explicit", null, timestamp);

      this.repository.logAudit({
        timestamp,
        actor: resolvedAuditContext.actor,
        action: "topic_reassign",
        memory_id: memoryId,
        detail: JSON.stringify({
          project: memory.project,
          memory_id: memoryId,
          from_topic_key: normalizedFromTopicKey,
          to_topic_key: normalizedToTopicKey,
          from_topic_id: fromTopic.id,
          to_topic_id: targetTopic.id,
          to_topic_created: toTopicCreated
        }),
        ip: resolvedAuditContext.ip,
        tenant_id: memory.tenant_id ?? resolvedAuditContext.tenant_id ?? null
      });
    });

    if (!targetTopic) {
      throw new Error(`Failed to resolve target topic: ${memory.project}:${normalizedToTopicKey}`);
    }

    return {
      memory_id: memoryId,
      project: memory.project,
      from_topic_id: fromTopic.id,
      to_topic_id: targetTopic.id,
      to_topic_created: toTopicCreated
    };
  }
}
