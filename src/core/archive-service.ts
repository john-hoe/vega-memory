import { createHash } from "node:crypto";

import { v4 as uuidv4 } from "uuid";

import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { generateEmbedding } from "../embedding/ollama.js";
import type {
  ArchiveEmbeddingBuildResult,
  ArchiveHashRepairResult,
  ArchiveStats,
  DeepRecallRequest,
  DeepRecallResponse,
  RawArchive,
  RawArchiveType
} from "./types.js";

interface ArchiveStoreOptions {
  tenant_id?: string | null;
  source_memory_id?: string | null;
  title?: string;
  source_uri?: string | null;
  metadata?: Record<string, unknown>;
  captured_at?: string | null;
}

interface ArchiveStoreResult {
  id: string;
  created: boolean;
  content_hash: string;
}

const now = (): string => new Date().toISOString();
const DEEP_RECALL_RAW_WARNING =
  "deep_recall returned raw archived content; treat the result as sensitive evidence.";

const buildArchiveTitle = (value: string | undefined, content: string): string => {
  const candidate = value?.trim();
  if (candidate) {
    return candidate;
  }

  const firstLine = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return "Untitled Archive";
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
};

const toContentHash = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const toEvidenceScore = (rank: number): number =>
  Number((1 / (1 + Math.abs(rank))).toFixed(3));

const toEmbeddingBuffer = (embedding: Float32Array | null): Buffer | null => {
  if (embedding === null) {
    return null;
  }

  return Buffer.from(
    embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength)
  );
};

const normalizeBatchSize = (value: number, fallback: number): number =>
  Number.isInteger(value) && value > 0 ? value : fallback;

export class ArchiveService {
  constructor(
    private readonly repository: Repository,
    private readonly config?: VegaConfig
  ) {}

  store(
    content: string,
    archiveType: RawArchiveType,
    project: string,
    options: ArchiveStoreOptions = {}
  ): ArchiveStoreResult {
    const tenantId = options.tenant_id ?? null;
    const contentHash = toContentHash(content);
    const existing = this.repository.getRawArchiveByHash(contentHash, tenantId);

    if (existing !== null) {
      return {
        id: existing.id,
        created: false,
        content_hash: contentHash
      };
    }

    const timestamp = now();
    const archive: RawArchive = {
      id: uuidv4(),
      tenant_id: tenantId,
      project,
      source_memory_id: options.source_memory_id ?? null,
      archive_type: archiveType,
      title: buildArchiveTitle(options.title, content),
      source_uri: options.source_uri ?? null,
      content,
      content_hash: contentHash,
      metadata: options.metadata ?? {},
      captured_at: options.captured_at ?? null,
      created_at: timestamp,
      updated_at: timestamp
    };

    try {
      this.repository.createRawArchive(archive);
    } catch (error) {
      const deduped = this.repository.getRawArchiveByHash(contentHash, tenantId);
      if (deduped !== null) {
        return {
          id: deduped.id,
          created: false,
          content_hash: contentHash
        };
      }

      throw error;
    }

    return {
      id: archive.id,
      created: true,
      content_hash: contentHash
    };
  }

  getStats(project?: string): ArchiveStats {
    return this.repository.getRawArchiveStats(project);
  }

  repairHashes(batchSize = 100, project?: string): ArchiveHashRepairResult {
    const timestamp = now();
    const candidates = this.repository.listRawArchivesMissingHash(
      normalizeBatchSize(batchSize, 100),
      project
    );
    const duplicates: ArchiveHashRepairResult["duplicates"] = [];
    let updated = 0;

    for (const candidate of candidates) {
      const contentHash = toContentHash(candidate.content);
      const existing = this.repository.getRawArchiveByHash(contentHash, candidate.tenant_id);

      if (existing !== null && existing.id !== candidate.id) {
        duplicates.push({
          id: candidate.id,
          duplicate_of: existing.id,
          tenant_id: candidate.tenant_id,
          project: candidate.project,
          content_hash: contentHash
        });
        continue;
      }

      this.repository.updateRawArchiveHash(candidate.id, contentHash, timestamp);
      updated += 1;
    }

    return {
      scanned: candidates.length,
      updated,
      duplicates
    };
  }

  async buildEmbeddings(
    batchSize = 50,
    project?: string
  ): Promise<ArchiveEmbeddingBuildResult> {
    if (this.config === undefined) {
      throw new Error("ArchiveService.buildEmbeddings requires VegaConfig");
    }

    const safeBatchSize = normalizeBatchSize(batchSize, 50);
    const hashRepair = this.repairHashes(safeBatchSize, project);
    const pending = this.repository.listRawArchivesWithoutEmbedding(safeBatchSize, project);
    let embedded = 0;
    let skipped = 0;

    for (const archive of pending) {
      const embedding = await generateEmbedding(archive.content, this.config);

      if (embedding === null) {
        skipped += 1;
        continue;
      }

      this.repository.setRawArchiveEmbedding(archive.id, toEmbeddingBuffer(embedding), now());
      embedded += 1;
    }

    return {
      requested: safeBatchSize,
      processed: pending.length,
      embedded,
      skipped,
      remaining_without_embedding: this.repository.countRawArchivesWithoutEmbedding(project),
      hash_repair: hashRepair
    };
  }

  retrieve(id: string, tenantId?: string | null): RawArchive | null {
    const archive = this.repository.getRawArchive(id);

    if (archive === null) {
      return null;
    }

    if (tenantId !== undefined && (archive.tenant_id ?? null) !== tenantId) {
      return null;
    }

    return archive;
  }

  search(
    query: string,
    project?: string,
    limit = 5,
    tenantId?: string | null
  ): Array<{ archive: RawArchive; rank: number }> {
    return this.repository.searchRawArchives(query, project, limit, tenantId);
  }

  deepRecall(request: DeepRecallRequest, tenantId?: string | null): DeepRecallResponse {
    const limit = request.limit ?? 5;
    const includeContent = request.include_content ?? true;
    const includeMetadata = request.include_metadata ?? false;
    const matches = this.search(request.query, request.project, limit, tenantId);
    const hasRawContent = includeContent
      ? matches.some(({ archive }) => archive.metadata.contains_raw === true)
      : false;
    const sourceMemoryIds = [
      ...new Set(
        matches
          .map(({ archive }) => archive.source_memory_id)
          .filter(
            (memoryId): memoryId is string =>
              typeof memoryId === "string" && memoryId.length > 0
          )
      )
    ];
    const memoriesById = new Map(
      this.repository.getMemoriesByIds(sourceMemoryIds).map((memory) => [memory.id, memory] as const)
    );

    return {
      results: matches.map(({ archive, rank }) => {
        const sourceMemory =
          archive.source_memory_id === null
            ? null
            : memoriesById.get(archive.source_memory_id) ?? null;
        const containsRaw = archive.metadata.contains_raw === true;

        return {
          archive_id: archive.id,
          memory_id: archive.source_memory_id,
          project: archive.project,
          type: sourceMemory?.type ?? null,
          archive_type: archive.archive_type,
          title: archive.title,
          ...(includeContent ? { content: archive.content } : {}),
          contains_raw: containsRaw && includeContent,
          ...(sourceMemory?.summary !== undefined ? { summary: sourceMemory.summary } : {}),
          ...(sourceMemory?.verified !== undefined ? { verified: sourceMemory.verified } : {}),
          ...(includeMetadata
            ? {
                metadata: archive.metadata,
                source_uri: archive.source_uri,
                captured_at: archive.captured_at
              }
            : {}),
          created_at: archive.created_at,
          updated_at: archive.updated_at,
          evidence_score: toEvidenceScore(rank)
        };
      }),
      next_cursor: null,
      injected_into_session: false,
      ...(hasRawContent ? { warnings: [DEEP_RECALL_RAW_WARNING] } : {})
    };
  }
}
