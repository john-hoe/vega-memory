import { createHash } from "node:crypto";

import type { MetadataEntry, StructuredGraph } from "./types.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { Repository } from "../db/repository.js";

export type GraphSidecarKind = "code" | "doc";

export interface GraphSidecarCacheRecord {
  hash: string;
  memoryIds: string[];
  itemCount: number;
}

interface SyncFileGraphParams {
  kind: GraphSidecarKind;
  scopeKey: string;
  relativePath: string;
  hash: string;
  itemCount: number;
  memoryGraphs: Array<{
    memoryId: string;
    graph: StructuredGraph;
  }>;
}

const buildScopeId = (scopeKey: string): string =>
  createHash("sha256").update(scopeKey).digest("hex");

const buildMetadataPrefix = (kind: GraphSidecarKind, scopeKey: string): string =>
  `sidecar:${kind}-graph:${buildScopeId(scopeKey)}:`;

const buildMetadataKey = (
  kind: GraphSidecarKind,
  scopeKey: string,
  relativePath: string
): string => `${buildMetadataPrefix(kind, scopeKey)}${relativePath}`;

const parseCacheRecord = (entry: MetadataEntry): GraphSidecarCacheRecord | null => {
  try {
    const parsed = JSON.parse(entry.value) as Partial<GraphSidecarCacheRecord>;

    if (
      typeof parsed.hash !== "string" ||
      !Array.isArray(parsed.memoryIds) ||
      parsed.memoryIds.some((memoryId) => typeof memoryId !== "string") ||
      typeof parsed.itemCount !== "number"
    ) {
      return null;
    }

    return {
      hash: parsed.hash,
      memoryIds: parsed.memoryIds,
      itemCount: parsed.itemCount
    };
  } catch {
    return null;
  }
};

export class GraphSidecarService {
  constructor(
    private readonly repository: Repository,
    private readonly knowledgeGraphService = new KnowledgeGraphService(repository)
  ) {}

  hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  getCacheRecord(
    kind: GraphSidecarKind,
    scopeKey: string,
    relativePath: string
  ): GraphSidecarCacheRecord | null {
    const value = this.repository.getMetadata(buildMetadataKey(kind, scopeKey, relativePath));

    if (value === null) {
      return null;
    }

    return parseCacheRecord({
      key: buildMetadataKey(kind, scopeKey, relativePath),
      value,
      updated_at: ""
    });
  }

  listCacheRecords(
    kind: GraphSidecarKind,
    scopeKey: string
  ): Array<{ relativePath: string; record: GraphSidecarCacheRecord }> {
    const prefix = buildMetadataPrefix(kind, scopeKey);

    return this.repository.listMetadata(prefix).flatMap((entry) => {
      const record = parseCacheRecord(entry);

      if (record === null) {
        return [];
      }

      return [
        {
          relativePath: entry.key.slice(prefix.length),
          record
        }
      ];
    });
  }

  isFileUnchanged(
    kind: GraphSidecarKind,
    scopeKey: string,
    relativePath: string,
    hash: string
  ): boolean {
    const record = this.getCacheRecord(kind, scopeKey, relativePath);

    return (
      record?.hash === hash &&
      record.memoryIds.length > 0 &&
      record.memoryIds.every((memoryId) => this.repository.getMemory(memoryId) !== null)
    );
  }

  syncFileGraph(params: SyncFileGraphParams): void {
    const previousRecord =
      this.getCacheRecord(params.kind, params.scopeKey, params.relativePath) ?? null;
    const currentMemoryIds = params.memoryGraphs.map(({ memoryId }) => memoryId);
    const staleMemoryIds = (previousRecord?.memoryIds ?? []).filter(
      (memoryId) => !currentMemoryIds.includes(memoryId)
    );

    for (const staleMemoryId of staleMemoryIds) {
      this.clearMemoryGraph(staleMemoryId);
    }

    for (const { memoryId, graph } of params.memoryGraphs) {
      this.knowledgeGraphService.replaceMemoryGraph(memoryId, graph);
    }

    this.repository.setMetadata(
      buildMetadataKey(params.kind, params.scopeKey, params.relativePath),
      JSON.stringify({
        hash: params.hash,
        memoryIds: currentMemoryIds,
        itemCount: params.itemCount
      } satisfies GraphSidecarCacheRecord)
    );
  }

  cleanupMissingFiles(
    kind: GraphSidecarKind,
    scopeKey: string,
    currentRelativePaths: Set<string>
  ): void {
    for (const { relativePath, record } of this.listCacheRecords(kind, scopeKey)) {
      if (currentRelativePaths.has(relativePath)) {
        continue;
      }

      for (const memoryId of record.memoryIds) {
        this.clearMemoryGraph(memoryId);
      }

      this.repository.deleteMetadata(buildMetadataKey(kind, scopeKey, relativePath));
    }
  }

  private clearMemoryGraph(memoryId: string): void {
    const entityIds = this.repository.getRelationEntityIdsForMemory(memoryId);

    this.repository.deleteStructuralRelationsForMemory(memoryId);
    this.repository.deleteInferredRelationsForMemory(memoryId);
    this.repository.pruneEntitiesWithoutRelations(entityIds);
  }
}
