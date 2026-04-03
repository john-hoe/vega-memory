import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Repository } from "../db/repository.js";
import type { MemoryType } from "./types.js";
import { MemoryService } from "./memory.js";

const TOKEN_CHAR_BUDGET = 12_000;

const appendWithinBudget = (current: string, chunk: string): string =>
  current.length + chunk.length > TOKEN_CHAR_BUDGET ? current : `${current}${chunk}`;

export function exportSnapshot(repository: Repository, outputPath: string): void {
  const memories = repository.listMemories({
    status: "active",
    limit: 50,
    sort: "importance DESC"
  });
  const grouped = new Map<MemoryType, typeof memories>();

  for (const memory of memories) {
    const entries = grouped.get(memory.type) ?? [];
    entries.push(memory);
    grouped.set(memory.type, entries);
  }

  let markdown = "# Memory Snapshot\n\n";

  for (const [type, entries] of grouped) {
    const sectionHeader = `## ${type}\n`;
    const nextMarkdown = appendWithinBudget(markdown, sectionHeader);
    if (nextMarkdown === markdown) {
      break;
    }
    markdown = `${nextMarkdown}\n`;

    for (const memory of entries) {
      const block = `### ${memory.title}\n${memory.content}\n\n`;
      const updated = appendWithinBudget(markdown, block);
      if (updated === markdown) {
        break;
      }
      markdown = updated;
    }
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown, "utf8");
}

export async function importPending(
  pendingPath: string,
  memoryService: MemoryService
): Promise<number> {
  const lines = readFileSync(pendingPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let imported = 0;
  for (const line of lines) {
    const parsed = JSON.parse(line) as {
      content: string;
      type: MemoryType;
      project: string;
      title?: string;
      tags?: string[];
      importance?: number;
      source?: "auto" | "explicit";
    };
    await memoryService.store(parsed);
    imported += 1;
  }

  unlinkSync(pendingPath);
  return imported;
}
