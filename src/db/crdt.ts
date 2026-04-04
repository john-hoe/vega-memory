import type { Memory, MergeResult } from "../core/types.js";

const CONFLICT_WINDOW_MS = 1_000;
const unique = (values: string[]): string[] => [...new Set(values)];

const getUpdatedAtMs = (memory: Memory): number => {
  const value = Date.parse(memory.updated_at);

  return Number.isFinite(value) ? value : 0;
};

const buffersEqual = (left: Buffer | null, right: Buffer | null): boolean => {
  if (left === null || right === null) {
    return left === right;
  }

  return left.equals(right);
};

const memoriesEqual = (left: Memory, right: Memory): boolean =>
  left.id === right.id &&
  left.type === right.type &&
  left.project === right.project &&
  left.title === right.title &&
  left.content === right.content &&
  buffersEqual(left.embedding, right.embedding) &&
  left.importance === right.importance &&
  left.source === right.source &&
  left.tags.length === right.tags.length &&
  left.tags.every((value, index) => value === right.tags[index]) &&
  left.created_at === right.created_at &&
  left.updated_at === right.updated_at &&
  left.accessed_at === right.accessed_at &&
  left.access_count === right.access_count &&
  left.status === right.status &&
  left.verified === right.verified &&
  left.scope === right.scope &&
  left.accessed_projects.length === right.accessed_projects.length &&
  left.accessed_projects.every((value, index) => value === right.accessed_projects[index]);

export class CRDTMerger {
  private mergeConcurrentMemory(local: Memory, remote: Memory): Memory {
    const localUpdatedAt = getUpdatedAtMs(local);
    const remoteUpdatedAt = getUpdatedAtMs(remote);
    const latest = remoteUpdatedAt >= localUpdatedAt ? remote : local;
    const older = latest === remote ? local : remote;
    const content =
      remote.content.length > local.content.length
        ? remote.content
        : local.content.length > remote.content.length
          ? local.content
          : latest.content;

    return {
      ...latest,
      content,
      embedding:
        content === latest.content
          ? latest.embedding
          : content === older.content
            ? older.embedding
            : null,
      importance: Math.max(local.importance, remote.importance),
      tags: unique([...latest.tags, ...older.tags]),
      created_at: local.created_at < remote.created_at ? local.created_at : remote.created_at,
      accessed_at: getUpdatedAtMs(local) >= getUpdatedAtMs(remote) ? local.accessed_at : remote.accessed_at,
      access_count: Math.max(local.access_count, remote.access_count),
      accessed_projects: unique([...latest.accessed_projects, ...older.accessed_projects])
    };
  }

  mergeMemories(local: Memory[], remote: Memory[]): MergeResult {
    const remoteById = new Map(remote.map((memory) => [memory.id, memory]));
    const merged: Memory[] = [];
    const conflicts: Memory[] = [];
    const seen = new Set<string>();
    let kept = 0;
    let added = 0;
    let updated = 0;

    for (const localMemory of local) {
      const remoteMemory = remoteById.get(localMemory.id);
      seen.add(localMemory.id);

      if (!remoteMemory) {
        merged.push(localMemory);
        kept += 1;
        continue;
      }

      const localUpdatedAt = getUpdatedAtMs(localMemory);
      const remoteUpdatedAt = getUpdatedAtMs(remoteMemory);
      let winner = remoteUpdatedAt > localUpdatedAt ? remoteMemory : localMemory;

      if (
        Math.abs(remoteUpdatedAt - localUpdatedAt) <= CONFLICT_WINDOW_MS &&
        !memoriesEqual(localMemory, remoteMemory)
      ) {
        winner = this.mergeConcurrentMemory(localMemory, remoteMemory);
        conflicts.push(winner);
      }

      merged.push(winner);

      if (winner === remoteMemory) {
        updated += 1;
      } else {
        kept += 1;
      }
    }

    for (const remoteMemory of remote) {
      if (seen.has(remoteMemory.id)) {
        continue;
      }

      merged.push(remoteMemory);
      added += 1;
    }

    return {
      merged,
      kept,
      added,
      updated,
      conflicts
    };
  }
}
