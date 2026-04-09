import { v4 as uuidv4 } from "uuid";

import type { VegaConfig } from "../config.js";
import type {
  AuditContext,
  Memory,
  MemorySource,
  MemoryType,
  MemoryUpdateParams,
  StoreParams,
  StoreResult
} from "./types.js";
import { ArchiveService } from "./archive-service.js";
import { Repository } from "../db/repository.js";
import { generateEmbedding, cosineSimilarity } from "../embedding/ollama.js";
import { shouldExclude } from "../security/exclusion.js";
import { redactSensitiveData } from "../security/redactor.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { generateSummary } from "./summarize.js";

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

const resolveAuditContext = (auditContext?: AuditContext): AuditContext => ({
  actor: auditContext?.actor ?? "system",
  ip: auditContext?.ip ?? null,
  tenant_id: auditContext?.tenant_id ?? null
});

const unique = (values: string[]): string[] => [...new Set(values)];

const normalizeToken = (value: string): string => value.trim().toLowerCase();

const normalizeTitle = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();

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
    private readonly config: VegaConfig,
    private readonly knowledgeGraphService = new KnowledgeGraphService(repository),
    private readonly archiveService = new ArchiveService(repository)
  ) {}

  private captureRawContent(
    content: string,
    project: string,
    type: MemoryType,
    tenantId: string | null,
    sourceMemoryId: string,
    title?: string
  ): void {
    this.archiveService.store(content, "document", project, {
      tenant_id: tenantId,
      source_memory_id: sourceMemoryId,
      title,
      metadata: {
        captured_from: "memory_service",
        memory_type: type
      }
    });
  }

  private linkKnowledgeGraph(memoryId: string, content: string, tags: string[]): void {
    const entities = this.knowledgeGraphService.extractEntities(content, tags);
    this.knowledgeGraphService.linkMemory(memoryId, entities);
  }

  private findMatch(
    project: string | undefined,
    type: MemoryType,
    embedding: Float32Array,
    tenantId: string | null
  ): { memory: Memory; similarity: number } | null {
    let bestMatch: { memory: Memory; similarity: number } | null = null;

    for (const candidate of this.repository.getAllEmbeddings(project, type)) {
      if (candidate.memory.status !== "active") {
        continue;
      }

      if ((candidate.memory.tenant_id ?? null) !== tenantId) {
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

  private archiveSupersededTaskStates(
    project: string,
    keepId: string,
    title: string,
    tenantId: string | null,
    auditContext?: AuditContext
  ): void {
    const normalizedTitle = normalizeTitle(title);

    if (normalizedTitle.length === 0) {
      return;
    }

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

      if ((memory.tenant_id ?? null) !== tenantId) {
        continue;
      }

      if (normalizeTitle(memory.title) !== normalizedTitle) {
        continue;
      }

      this.repository.updateMemory(
        memory.id,
        {
          status: "archived",
          updated_at: archivedAt
        },
        { auditContext }
      );
    }
  }

  async store(params: StoreParams): Promise<StoreResult> {
    const auditContext = resolveAuditContext(params.auditContext);
    const tenantId = params.tenant_id ?? auditContext.tenant_id ?? null;
    const source = params.source ?? "auto";
    const rawContent = params.content;

    if (source !== "explicit") {
      const exclusion = shouldExclude(params.content);

      if (exclusion.excluded) {
        return {
          id: "",
          action: "excluded",
          title: exclusion.reason
        };
      }
    }

    const { redacted, wasRedacted } = redactSensitiveData(
      params.content,
      this.config.customRedactionPatterns
    );
    const embedding = await generateEmbedding(redacted, this.config);
    const title = buildTitle(params.title, redacted);
    const tags = unique(
      (params.tags?.length ? params.tags : extractTags(redacted)).map(normalizeToken).filter(Boolean)
    );
    const importance = defaultImportanceFor(params.type, source, params.importance);
    const scope = params.type === "preference" ? "global" : "project";
    const matched =
      embedding === null || params.skipSimilarityCheck
        ? null
        : this.findMatch(
            params.type === "preference" ? undefined : params.project,
            params.type,
            embedding,
            tenantId
          );
    const timestamp = now();
    const summary = await generateSummary(redacted, this.config);

    if (
      matched !== null &&
      matched.memory.verified === "verified" &&
      contradicts(matched.memory.content, redacted)
    ) {
      const id = uuidv4();
      this.repository.createMemory(
        {
          id,
          tenant_id: tenantId,
          type: params.type,
          project: params.project,
          title,
          content: redacted,
          summary,
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
        },
        auditContext
      );

      if (params.type === "task_state") {
        this.archiveSupersededTaskStates(params.project, id, title, tenantId, auditContext);
      }

      this.repository.logAudit({
        timestamp,
        actor: auditContext.actor,
        action: "store_conflict",
        memory_id: id,
        detail: `Stored conflicting ${params.type} memory${wasRedacted ? " after redaction" : ""}`,
        ip: auditContext.ip,
        tenant_id: tenantId
      });

      this.linkKnowledgeGraph(id, redacted, tags);
      this.captureRawContent(rawContent, params.project, params.type, tenantId, id, params.title);

      return { id, action: "conflict", title };
    }

    if (matched !== null) {
      const mergedContent = mergeContent(matched.memory.content, redacted);
      const mergedTags = unique([...matched.memory.tags, ...tags]);
      const nextSource =
        matched.memory.source === "explicit" || source === "explicit" ? "explicit" : "auto";
      const verified = source === "explicit" ? "verified" : matched.memory.verified;
      const nextTitle = params.title?.trim() ? title : matched.memory.title;
      const nextEmbedding =
        mergedContent === matched.memory.content
          ? matched.memory.embedding
          : toEmbeddingBuffer(
              mergedContent === redacted
                ? embedding
                : await generateEmbedding(mergedContent, this.config)
            );
      const nextSummary =
        mergedContent === matched.memory.content
          ? matched.memory.summary
          : mergedContent === redacted
            ? summary
            : await generateSummary(mergedContent, this.config);

      this.repository.updateMemory(
        matched.memory.id,
        {
          title: nextTitle,
          content: mergedContent,
          summary: nextSummary,
          embedding: nextEmbedding,
          importance: Math.max(matched.memory.importance, importance),
          source: nextSource,
          tags: mergedTags,
          updated_at: timestamp,
          accessed_at: timestamp,
          verified,
          accessed_projects: unique([...matched.memory.accessed_projects, params.project])
        },
        { auditContext }
      );

      if (params.type === "task_state") {
        this.archiveSupersededTaskStates(
          params.project,
          matched.memory.id,
          nextTitle,
          tenantId,
          auditContext
        );
      }

      this.repository.logAudit({
        timestamp,
        actor: auditContext.actor,
        action: "store_updated",
        memory_id: matched.memory.id,
        detail: `Updated ${params.type} memory from store pipeline${wasRedacted ? " after redaction" : ""}`,
        ip: auditContext.ip,
        tenant_id: tenantId
      });

      this.linkKnowledgeGraph(matched.memory.id, mergedContent, mergedTags);
      this.captureRawContent(
        rawContent,
        params.project,
        params.type,
        tenantId,
        matched.memory.id,
        params.title ?? matched.memory.title
      );

      return { id: matched.memory.id, action: "updated", title: nextTitle };
    }

    const id = uuidv4();
    const verified = source === "explicit" ? "verified" : "unverified";

    this.repository.createMemory(
      {
        id,
        tenant_id: tenantId,
        type: params.type,
        project: params.project,
        title,
        content: redacted,
        summary,
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
      },
      auditContext
    );

    if (params.type === "task_state") {
      this.archiveSupersededTaskStates(params.project, id, title, tenantId, auditContext);
    }

    this.repository.logAudit({
      timestamp,
      actor: auditContext.actor,
      action: "store_created",
      memory_id: id,
      detail: `Created ${params.type} memory from store pipeline${wasRedacted ? " after redaction" : ""}`,
      ip: auditContext.ip,
      tenant_id: tenantId
    });

    this.linkKnowledgeGraph(id, redacted, tags);
    this.captureRawContent(rawContent, params.project, params.type, tenantId, id, params.title);

    return { id, action: "created", title };
  }

  async update(id: string, updates: MemoryUpdateParams, auditContext?: AuditContext): Promise<void> {
    const existing = this.repository.getMemory(id);
    if (!existing) {
      throw new Error(`Memory not found: ${id}`);
    }

    const nextUpdates: Partial<Memory> = {};
    let rawContentToArchive: string | null = null;
    if (updates.content !== undefined) {
      const rawContent = updates.content;
      const { redacted } = redactSensitiveData(
        updates.content,
        this.config.customRedactionPatterns
      );
      nextUpdates.content = redacted;
      nextUpdates.summary = await generateSummary(redacted, this.config);
      nextUpdates.embedding = toEmbeddingBuffer(await generateEmbedding(redacted, this.config));
      nextUpdates.tags =
        updates.tags !== undefined
          ? unique(updates.tags.map(normalizeToken).filter(Boolean))
          : extractTags(redacted);
      rawContentToArchive = rawContent;
    }
    if (updates.importance !== undefined) {
      nextUpdates.importance = Math.max(0, Math.min(1, updates.importance));
    }
    if (updates.tags !== undefined && updates.content === undefined) {
      nextUpdates.tags = unique(updates.tags.map(normalizeToken).filter(Boolean));
    }
    if (updates.title !== undefined) {
      const title = updates.title.trim();
      if (title.length > 0) {
        nextUpdates.title = title;
      }
    }

    nextUpdates.updated_at = now();
    this.repository.updateMemory(id, nextUpdates, { auditContext });
    if (rawContentToArchive !== null) {
      this.captureRawContent(
        rawContentToArchive,
        existing.project,
        existing.type,
        existing.tenant_id ?? null,
        existing.id,
        updates.title ?? existing.title
      );
    }

    const refreshed = this.repository.getMemory(id);
    if (refreshed) {
      this.linkKnowledgeGraph(id, refreshed.content, refreshed.tags);
    }
  }

  async delete(id: string, auditContext?: AuditContext): Promise<void> {
    this.repository.deleteMemory(id, auditContext);
  }
}
