import type { VegaConfig } from "../config.js";
import type { Memory } from "./types.js";
import { Repository } from "../db/repository.js";
import { cosineSimilarity } from "../embedding/ollama.js";

const SIMILARITY_THRESHOLD = 0.9;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const COMPLETED_TASK_PATTERN = /\b(done|completed|complete|resolved|finished|closed)\b/i;

const now = (): string => new Date().toISOString();

const unique = (values: string[]): string[] => [...new Set(values)];

const toFloat32Array = (embedding: Buffer): Float32Array =>
  new Float32Array(
    embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength)
  );

const mergeContent = (newer: string, older: string): string => {
  const recent = newer.trim();
  const previous = older.trim();

  if (recent.includes(previous)) {
    return newer;
  }

  if (previous.includes(recent)) {
    return older;
  }

  return `${recent}\n\n${previous}`;
};

const isOlderThanSevenDays = (value: string): boolean =>
  Date.now() - Date.parse(value) > SEVEN_DAYS_MS;

const isCompletedTaskState = (memory: Memory): boolean =>
  memory.type === "task_state" &&
  memory.importance <= 0.2 &&
  COMPLETED_TASK_PATTERN.test(memory.content) &&
  isOlderThanSevenDays(memory.updated_at);

export class CompactService {
  constructor(
    private readonly repository: Repository,
    private readonly _config: VegaConfig
  ) {}

  compact(project?: string): { merged: number; archived: number } {
    const embeddings = this.repository
      .getAllEmbeddings(project)
      .filter(({ memory }) => memory.status === "active");
    const archivedIds = new Set<string>();
    let merged = 0;
    let archived = 0;

    for (let leftIndex = 0; leftIndex < embeddings.length; leftIndex += 1) {
      const left = embeddings[leftIndex];
      if (archivedIds.has(left.memory.id)) {
        continue;
      }

      for (let rightIndex = leftIndex + 1; rightIndex < embeddings.length; rightIndex += 1) {
        const right = embeddings[rightIndex];
        if (archivedIds.has(right.memory.id)) {
          continue;
        }

        const similarity = cosineSimilarity(
          toFloat32Array(left.embedding),
          toFloat32Array(right.embedding)
        );

        if (similarity <= SIMILARITY_THRESHOLD) {
          continue;
        }

        const leftUpdated = Date.parse(left.memory.updated_at);
        const rightUpdated = Date.parse(right.memory.updated_at);
        const newer = leftUpdated >= rightUpdated ? left.memory : right.memory;
        const older = newer.id === left.memory.id ? right.memory : left.memory;
        const timestamp = now();

        this.repository.updateMemory(newer.id, {
          content: mergeContent(newer.content, older.content),
          importance: Math.max(newer.importance, older.importance),
          tags: unique([...newer.tags, ...older.tags]),
          updated_at: timestamp,
          accessed_projects: unique([...newer.accessed_projects, ...older.accessed_projects])
        });
        this.repository.updateMemory(older.id, {
          status: "archived",
          updated_at: timestamp
        });

        archivedIds.add(older.id);
        merged += 1;
        archived += 1;
      }
    }

    const activeMemories = this.repository.listMemories({
      project,
      status: "active",
      limit: 10_000
    });
    const timestamp = now();

    for (const memory of activeMemories) {
      if (archivedIds.has(memory.id)) {
        continue;
      }

      if (memory.importance < 0.1 || isCompletedTaskState(memory)) {
        this.repository.updateMemory(memory.id, {
          status: "archived",
          updated_at: timestamp
        });
        archivedIds.add(memory.id);
        archived += 1;
      }
    }

    return { merged, archived };
  }
}
