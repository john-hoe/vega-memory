import { v4 as uuidv4 } from "uuid";

import type { VegaConfig } from "../config.js";
import type { Memory, MemorySource, MemoryType } from "./types.js";
import { Repository } from "../db/repository.js";
import { generateEmbedding, cosineSimilarity } from "../embedding/ollama.js";
import { redactSensitiveData } from "../security/redactor.js";

const DEFAULT_IMPORTANCE: Record<MemoryType, number> = {
  preference: 0.95,
  project_context: 0.85,
  task_state: 0.9,
  pitfall: 0.7,
  decision: 0.5,
  insight: 0.75
};

const NEGATION_PATTERN = /\b(no|not|never|cannot|can't|dont|don't|wont|won't|shouldn't|shouldnt)\b/i;
const STOP_WORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "will",
  "into",
  "about",
  "there",
  "their",
  "would",
  "could",
  "should",
  "task",
  "project",
  "memory"
]);

const toEmbeddingBuffer = (embedding: Float32Array | null): Buffer | null => {
  if (embedding === null) {
    return null;
  }

  return Buffer.from(
    embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength)
  );
};

const toFloat32Array = (embedding: Buffer): Float32Array =>
  new Float32Array(
    embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength)
  );

const now = (): string => new Date().toISOString();

const unique = (values: string[]): string[] => [...new Set(values)];

const normalizeToken = (value: string): string => value.trim().toLowerCase();

const extractTags = (content: string): string[] =>
  unique(
    content
      .split(/[\s,.;:!?()[\]{}<>/\\|"'`~\-_=+]+/)
      .map(normalizeToken)
      .filter((token) => token.length > 3 && !STOP_WORDS.has(token))
  );

const buildTitle = (title: string | undefined, content: string): string => {
  const candidate = title?.trim();
  if (candidate) {
    return candidate;
  }

  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return "Untitled Memory";
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
};

const defaultImportanceFor = (
  type: MemoryType,
  source: MemorySource,
  providedImportance?: number
): number => {
  if (providedImportance !== undefined) {
    return Math.max(0, Math.min(1, providedImportance));
  }

  const base = DEFAULT_IMPORTANCE[type];
  const bonus = source === "explicit" ? 0.1 : 0;

  return Math.min(1, base + bonus);
};

const mergeContent = (existingContent: string, incomingContent: string): string => {
  const current = existingContent.trim();
  const next = incomingContent.trim();

  if (current === next || current.includes(next)) {
    return existingContent;
  }

  if (next.includes(current)) {
    return incomingContent;
  }

  return `${current}\n\n${next}`;
};

const getKeywords = (content: string): Set<string> =>
  new Set(
    content
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3 && !STOP_WORDS.has(token))
  );

const contradicts = (existingContent: string, incomingContent: string): boolean => {
  const existingNegated = NEGATION_PATTERN.test(existingContent);
  const incomingNegated = NEGATION_PATTERN.test(incomingContent);

  if (existingNegated === incomingNegated) {
    return false;
  }

  const existingKeywords = getKeywords(existingContent);
  const incomingKeywords = getKeywords(incomingContent);
  const overlap = [...existingKeywords].filter((keyword) => incomingKeywords.has(keyword));

  return overlap.length > 0;
};

export class MemoryService {
  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {}

  private findMatch(
    project: string,
    type: MemoryType,
    embedding: Float32Array
  ): { memory: Memory; similarity: number } | null {
    let bestMatch: { memory: Memory; similarity: number } | null = null;

    for (const candidate of this.repository.getAllEmbeddings(project, type)) {
      if (candidate.memory.status !== "active") {
        continue;
      }

      const similarity = cosineSimilarity(embedding, toFloat32Array(candidate.embedding));
      if (similarity <= this.config.similarityThreshold) {
        continue;
      }

      if (bestMatch === null || similarity > bestMatch.similarity) {
        bestMatch = {
          memory: candidate.memory,
          similarity
        };
      }
    }

    return bestMatch;
  }

  private archiveOldTaskStates(project: string, keepId: string): void {
    const activeTaskStates = this.repository.listMemories({
      project,
      type: "task_state",
      status: "active",
      limit: 1_000
    });

    const archivedAt = now();
    for (const memory of activeTaskStates) {
      if (memory.id === keepId) {
        continue;
      }

      this.repository.updateMemory(memory.id, {
        status: "archived",
        updated_at: archivedAt
      });
    }
  }

  async store(params: {
    content: string;
    type: MemoryType;
    project: string;
    title?: string;
    tags?: string[];
    importance?: number;
    source?: MemorySource;
  }): Promise<{ id: string; action: "created" | "updated" | "conflict"; title: string }> {
    const source = params.source ?? "auto";
    const { redacted, wasRedacted } = redactSensitiveData(params.content);
    const embedding = await generateEmbedding(redacted, this.config);
    const title = buildTitle(params.title, redacted);
    const tags = unique(
      (params.tags?.length ? params.tags : extractTags(redacted)).map(normalizeToken).filter(Boolean)
    );
    const importance = defaultImportanceFor(params.type, source, params.importance);
    const scope = params.type === "preference" ? "global" : "project";
    const matched = embedding === null ? null : this.findMatch(params.project, params.type, embedding);
    const timestamp = now();

    if (
      matched !== null &&
      matched.memory.verified === "verified" &&
      contradicts(matched.memory.content, redacted)
    ) {
      const id = uuidv4();
      this.repository.createMemory({
        id,
        type: params.type,
        project: params.project,
        title,
        content: redacted,
        embedding: toEmbeddingBuffer(embedding),
        importance,
        source,
        tags,
        created_at: timestamp,
        updated_at: timestamp,
        accessed_at: timestamp,
        status: "active",
        verified: "conflict",
        scope,
        accessed_projects: [params.project]
      });

      if (params.type === "task_state") {
        this.archiveOldTaskStates(params.project, id);
      }

      this.repository.logAudit({
        timestamp,
        actor: "system",
        action: "store_conflict",
        memory_id: id,
        detail: `Stored conflicting ${params.type} memory${wasRedacted ? " after redaction" : ""}`,
        ip: null
      });

      return { id, action: "conflict", title };
    }

    if (matched !== null) {
      const mergedContent = mergeContent(matched.memory.content, redacted);
      const mergedTags = unique([...matched.memory.tags, ...tags]);
      const verified = source === "explicit" ? "verified" : matched.memory.verified;
      const nextTitle = params.title?.trim() ? title : matched.memory.title;

      this.repository.updateMemory(matched.memory.id, {
        title: nextTitle,
        content: mergedContent,
        embedding: toEmbeddingBuffer(embedding),
        importance: Math.max(matched.memory.importance, importance),
        source,
        tags: mergedTags,
        updated_at: timestamp,
        accessed_at: timestamp,
        verified,
        accessed_projects: unique([...matched.memory.accessed_projects, params.project])
      });

      if (params.type === "task_state") {
        this.archiveOldTaskStates(params.project, matched.memory.id);
      }

      this.repository.logAudit({
        timestamp,
        actor: "system",
        action: "store_updated",
        memory_id: matched.memory.id,
        detail: `Updated ${params.type} memory from store pipeline${wasRedacted ? " after redaction" : ""}`,
        ip: null
      });

      return { id: matched.memory.id, action: "updated", title: nextTitle };
    }

    const id = uuidv4();
    const verified = source === "explicit" ? "verified" : "unverified";

    this.repository.createMemory({
      id,
      type: params.type,
      project: params.project,
      title,
      content: redacted,
      embedding: toEmbeddingBuffer(embedding),
      importance,
      source,
      tags,
      created_at: timestamp,
      updated_at: timestamp,
      accessed_at: timestamp,
      status: "active",
      verified,
      scope,
      accessed_projects: [params.project]
    });

    if (params.type === "task_state") {
      this.archiveOldTaskStates(params.project, id);
    }

    this.repository.logAudit({
      timestamp,
      actor: "system",
      action: "store_created",
      memory_id: id,
      detail: `Created ${params.type} memory from store pipeline${wasRedacted ? " after redaction" : ""}`,
      ip: null
    });

    return { id, action: "created", title };
  }

  async update(
    id: string,
    updates: { content?: string; importance?: number; tags?: string[] }
  ): Promise<void> {
    const existing = this.repository.getMemory(id);
    if (!existing) {
      throw new Error(`Memory not found: ${id}`);
    }

    const nextUpdates: Partial<Memory> = {};
    if (updates.content !== undefined) {
      const { redacted } = redactSensitiveData(updates.content);
      nextUpdates.content = redacted;
      nextUpdates.embedding = toEmbeddingBuffer(await generateEmbedding(redacted, this.config));
    }
    if (updates.importance !== undefined) {
      nextUpdates.importance = Math.max(0, Math.min(1, updates.importance));
    }
    if (updates.tags !== undefined) {
      nextUpdates.tags = unique(updates.tags.map(normalizeToken).filter(Boolean));
    }

    nextUpdates.updated_at = now();
    this.repository.updateMemory(id, nextUpdates);
  }

  async delete(id: string): Promise<void> {
    this.repository.deleteMemory(id);
  }
}
