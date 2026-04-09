import { createHash } from "node:crypto";

import { v4 as uuidv4 } from "uuid";

import { Repository } from "../db/repository.js";
import type {
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

export class ArchiveService {
  constructor(private readonly repository: Repository) {}

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
    const sourceMemoryIds = [...new Set(
      matches
        .map(({ archive }) => archive.source_memory_id)
        .filter((memoryId): memoryId is string => typeof memoryId === "string" && memoryId.length > 0)
    )];
    const memoriesById = new Map(
      this.repository.getMemoriesByIds(sourceMemoryIds).map((memory) => [memory.id, memory] as const)
    );

    return {
      results: matches.map(({ archive, rank }) => {
        const sourceMemory =
          archive.source_memory_id === null
            ? null
            : memoriesById.get(archive.source_memory_id) ?? null;

        return {
          archive_id: archive.id,
          memory_id: archive.source_memory_id,
          project: archive.project,
          type: sourceMemory?.type ?? null,
          archive_type: archive.archive_type,
          title: archive.title,
          ...(includeContent ? { content: archive.content } : {}),
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
      injected_into_session: false
    };
  }
}
