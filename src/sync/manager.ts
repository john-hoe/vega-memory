import { rmSync } from "node:fs";

import type { Memory } from "../core/types.js";
import { CRDTMerger } from "../db/crdt.js";
import { Repository } from "../db/repository.js";
import { VegaSyncClient } from "./client.js";
import { PendingQueue } from "./queue.js";

const memoriesEqual = (left: Memory, right: Memory): boolean =>
  left.id === right.id &&
  left.type === right.type &&
  left.project === right.project &&
  left.title === right.title &&
  left.content === right.content &&
  left.importance === right.importance &&
  left.source === right.source &&
  left.created_at === right.created_at &&
  left.updated_at === right.updated_at &&
  left.accessed_at === right.accessed_at &&
  left.access_count === right.access_count &&
  left.status === right.status &&
  left.verified === right.verified &&
  left.scope === right.scope &&
  JSON.stringify(left.tags) === JSON.stringify(right.tags) &&
  JSON.stringify(left.accessed_projects) === JSON.stringify(right.accessed_projects);

export class SyncManager {
  private readonly merger = new CRDTMerger();

  constructor(
    private readonly client: VegaSyncClient,
    private readonly queue: PendingQueue,
    private readonly cacheRepo: Repository
  ) {}

  async syncPending(): Promise<number> {
    if (!(await this.client.isServerReachable())) {
      return 0;
    }

    if (!(await this.client.isAuthenticated())) {
      console.warn("Sync failed: invalid API key");
      return 0;
    }

    const operations = this.queue.dequeue();
    let synced = 0;

    for (const operation of operations) {
      try {
        await this.client.replay(operation);
        if (operation.batchFile) {
          rmSync(operation.batchFile, { force: true });
        }
        synced += 1;
      } catch {
        return synced;
      }
    }

    try {
      const localMemories = this.cacheRepo.listMemories({
        limit: 1_000_000
      });
      const remoteMemories = await this.client.fetchRemoteMemories();
      const remoteById = new Map(remoteMemories.map((memory) => [memory.id, memory]));
      const merged = this.merger.mergeMemories(
        localMemories.filter((memory) => remoteById.has(memory.id)),
        remoteMemories
      );

      for (const memory of merged.merged) {
        const remoteMemory = remoteById.get(memory.id);

        if (!remoteMemory || memoriesEqual(remoteMemory, memory)) {
          continue;
        }

        await this.client.replay({
          type: "update",
          params: {
            id: memory.id,
            content: memory.content,
            importance: memory.importance,
            tags: memory.tags
          },
          timestamp: new Date().toISOString()
        });
      }

      await this.refreshCache(await this.client.fetchRemoteMemories());
      this.queue.clear();
    } catch {
      return synced;
    }

    return synced;
  }

  async refreshCache(memories: Memory[]): Promise<void> {
    const existingMemories = this.cacheRepo.listMemories({
      limit: 1_000_000
    });
    const existingById = new Map(existingMemories.map((memory) => [memory.id, memory]));
    const incomingById = new Map(memories.map((memory) => [memory.id, memory]));

    for (const memory of memories) {
      const existing = existingById.get(memory.id);
      const nextMemory: Memory = {
        ...memory,
        embedding: existing?.embedding ?? memory.embedding ?? null
      };

      if (!existing) {
        const { access_count: _accessCount, ...createdMemory } = nextMemory;
        this.cacheRepo.createMemory(createdMemory);
        continue;
      }

      if (memoriesEqual(existing, nextMemory)) {
        continue;
      }

      this.cacheRepo.updateMemory(
        nextMemory.id,
        {
          ...nextMemory
        },
        {
          skipVersion: true
        }
      );
    }

    for (const existing of existingMemories) {
      if (!incomingById.has(existing.id)) {
        this.cacheRepo.deleteMemory(existing.id);
      }
    }
  }
}
