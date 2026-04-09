import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

import type {
  GraphContentCacheKind,
  GraphContentCacheRecord,
  GraphDirectoryScanFile,
  GraphDirectoryScanResult,
  StructuredGraph
} from "./types.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { Repository } from "../db/repository.js";

interface SyncFileCacheParams {
  kind: GraphContentCacheKind;
  scopeKey: string;
  relativePath: string;
  hash: string;
  itemCount: number;
  memoryIds: string[];
  lastModifiedMs: number | null;
}

interface SyncFileGraphParams extends SyncFileCacheParams {
  memoryGraphs: Array<{
    memoryId: string;
    graph: StructuredGraph;
  }>;
}

const SKIPPED_DIRECTORIES = new Set([".git", "dist", "node_modules"]);

const normalizeGraphPath = (value: string): string => value.replaceAll("\\", "/");

const walkFiles = (directoryPath: string): string[] => {
  const entries = readdirSync(directoryPath).sort((left, right) => left.localeCompare(right));
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(directoryPath, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry)) {
        continue;
      }

      files.push(...walkFiles(fullPath));
      continue;
    }

    if (stats.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
};

const toStatus = (
  status: GraphDirectoryScanFile["status"],
  absolutePath: string,
  filePath: string,
  contentHash: string,
  lastModifiedMs: number | null
): GraphDirectoryScanFile => ({
  absolute_path: absolutePath,
  file_path: filePath,
  status,
  content_hash: contentHash,
  last_modified_ms: lastModifiedMs
});

export class GraphSidecarService {
  constructor(
    private readonly repository: Repository,
    private readonly knowledgeGraphService = new KnowledgeGraphService(repository)
  ) {}

  hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  getCacheRecord(
    kind: GraphContentCacheKind,
    scopeKey: string,
    relativePath: string
  ): GraphContentCacheRecord | null {
    return this.repository.getGraphContentCache(kind, scopeKey, relativePath);
  }

  listCacheRecords(kind: GraphContentCacheKind, scopeKey: string): GraphContentCacheRecord[] {
    return this.repository.listGraphContentCache(kind, scopeKey);
  }

  isFileUnchanged(
    kind: GraphContentCacheKind,
    scopeKey: string,
    relativePath: string,
    hash: string
  ): boolean {
    const record = this.getCacheRecord(kind, scopeKey, relativePath);

    return record !== null && record.content_hash === hash && this.hasTrackedState(record);
  }

  scanDirectory(
    kind: GraphContentCacheKind,
    scopeKey: string,
    directoryPath: string,
    allowedExtensions: Set<string>
  ): GraphDirectoryScanResult {
    const absoluteDirectory = resolve(directoryPath);
    const cacheRecords = this.listCacheRecords(kind, scopeKey);
    const cacheByPath = new Map(cacheRecords.map((record) => [record.file_path, record]));
    const currentFiles: GraphDirectoryScanFile[] = [];
    const newFiles: GraphDirectoryScanFile[] = [];
    const modifiedFiles: GraphDirectoryScanFile[] = [];
    const unchangedFiles: GraphDirectoryScanFile[] = [];

    for (const filePath of walkFiles(absoluteDirectory)) {
      if (!allowedExtensions.has(extname(filePath).toLowerCase())) {
        continue;
      }

      const relativePath = normalizeGraphPath(
        relative(absoluteDirectory, filePath) || basename(filePath)
      );
      const cached = cacheByPath.get(relativePath) ?? null;
      const lastModifiedMs = statSync(filePath).mtimeMs;

      cacheByPath.delete(relativePath);

      if (cached === null) {
        const scanned = toStatus(
          "new",
          filePath,
          relativePath,
          this.hashContent(readFileSync(filePath, "utf8")),
          lastModifiedMs
        );

        currentFiles.push(scanned);
        newFiles.push(scanned);
        continue;
      }

      if (this.hasUnchangedMtime(cached, lastModifiedMs) && this.hasTrackedState(cached)) {
        const scanned = toStatus(
          "unchanged",
          filePath,
          relativePath,
          cached.content_hash,
          lastModifiedMs
        );

        currentFiles.push(scanned);
        unchangedFiles.push(scanned);
        continue;
      }

      const contentHash = this.hashContent(readFileSync(filePath, "utf8"));
      const scanned = toStatus(
        contentHash === cached.content_hash && this.hasTrackedState(cached) ? "unchanged" : "modified",
        filePath,
        relativePath,
        contentHash,
        lastModifiedMs
      );

      currentFiles.push(scanned);

      if (scanned.status === "unchanged") {
        unchangedFiles.push(scanned);
      } else {
        modifiedFiles.push(scanned);
      }
    }

    const deletedFiles = [...cacheByPath.values()];

    return {
      current_files: currentFiles,
      new_files: newFiles,
      modified_files: modifiedFiles,
      unchanged_files: unchangedFiles,
      deleted_files: deletedFiles,
      status: {
        indexed_files: cacheRecords.length,
        pending_files: newFiles.length + modifiedFiles.length,
        new_files: newFiles.length,
        modified_files: modifiedFiles.length,
        deleted_files: deletedFiles.length,
        unchanged_files: unchangedFiles.length
      }
    };
  }

  syncFileCache(params: SyncFileCacheParams): void {
    const previousRecord =
      this.getCacheRecord(params.kind, params.scopeKey, params.relativePath) ?? null;
    const currentMemoryIds = [...new Set(params.memoryIds)];
    const staleMemoryIds = (previousRecord?.memory_ids ?? []).filter(
      (memoryId) => !currentMemoryIds.includes(memoryId)
    );

    this.deleteTrackedMemories(staleMemoryIds);
    this.repository.setGraphContentCache({
      kind: params.kind,
      scope_key: params.scopeKey,
      file_path: params.relativePath,
      content_hash: params.hash,
      entity_count: params.itemCount,
      memory_ids: currentMemoryIds,
      last_modified_ms: params.lastModifiedMs
    });
  }

  syncFileGraph(params: SyncFileGraphParams): void {
    const previousRecord =
      this.getCacheRecord(params.kind, params.scopeKey, params.relativePath) ?? null;
    const currentMemoryIds = [...new Set(params.memoryGraphs.map(({ memoryId }) => memoryId))];
    const staleMemoryIds = (previousRecord?.memory_ids ?? []).filter(
      (memoryId) => !currentMemoryIds.includes(memoryId)
    );

    this.deleteTrackedMemories(staleMemoryIds);

    for (const { memoryId, graph } of params.memoryGraphs) {
      this.knowledgeGraphService.replaceMemoryGraph(memoryId, graph);
    }

    this.repository.setGraphContentCache({
      kind: params.kind,
      scope_key: params.scopeKey,
      file_path: params.relativePath,
      content_hash: params.hash,
      entity_count: params.itemCount,
      memory_ids: currentMemoryIds,
      last_modified_ms: params.lastModifiedMs
    });
  }

  cleanupDeletedFiles(deletedFiles: GraphContentCacheRecord[]): void {
    for (const record of deletedFiles) {
      this.deleteTrackedMemories(record.memory_ids);
      this.repository.deleteGraphContentCache(record.kind, record.scope_key, record.file_path);
    }
  }

  private hasTrackedState(record: GraphContentCacheRecord): boolean {
    if (record.memory_ids.length === 0) {
      return record.entity_count === 0;
    }

    return record.memory_ids.every((memoryId) => this.repository.getMemory(memoryId) !== null);
  }

  private hasUnchangedMtime(record: GraphContentCacheRecord, lastModifiedMs: number | null): boolean {
    return (
      record.last_modified_ms !== null &&
      lastModifiedMs !== null &&
      Math.abs(record.last_modified_ms - lastModifiedMs) < 1
    );
  }

  private deleteTrackedMemories(memoryIds: string[]): void {
    for (const memoryId of [...new Set(memoryIds)]) {
      const entityIds = this.repository.getRelationEntityIdsForMemory(memoryId);

      this.repository.deleteMemory(memoryId);
      this.repository.pruneEntitiesWithoutRelations(entityIds);
    }
  }
}
