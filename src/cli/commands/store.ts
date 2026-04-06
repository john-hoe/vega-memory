import { Command, InvalidArgumentError, Option } from "commander";

import { MemoryService } from "../../core/memory.js";
import type { AuditContext, MemorySource, MemoryType } from "../../core/types.js";

const MEMORY_TYPES = [
  "task_state",
  "preference",
  "project_context",
  "decision",
  "pitfall",
  "insight"
] as const satisfies readonly MemoryType[];

const MEMORY_SOURCES = ["auto", "explicit"] as const satisfies readonly MemorySource[];
const CLI_AUDIT_CONTEXT: AuditContext = { actor: "cli", ip: null };

const parseTags = (value: string): string[] =>
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

const parseImportance = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("importance must be a number between 0 and 1");
  }

  return parsed;
};

export function registerStoreCommand(program: Command, memoryService: MemoryService): void {
  program
    .command("store")
    .description("Store a memory entry")
    .argument("<content>", "memory content")
    .addOption(new Option("--type <type>", "memory type").choices([...MEMORY_TYPES]).makeOptionMandatory())
    .option("--project <project>", "project name", "global")
    .option("--title <title>", "memory title")
    .option("--tags <tags>", "comma-separated tags", parseTags)
    .option("--importance <importance>", "importance from 0 to 1", parseImportance)
    .addOption(new Option("--source <source>", "memory source").choices([...MEMORY_SOURCES]))
    .action(
      async (
        content: string,
        options: {
          type: MemoryType;
          project: string;
          title?: string;
          tags?: string[];
          importance?: number;
          source?: MemorySource;
        }
      ) => {
        const result = await memoryService.store({
          content,
          type: options.type,
          project: options.project,
          title: options.title,
          tags: options.tags,
          importance: options.importance,
          source: options.source,
          auditContext: CLI_AUDIT_CONTEXT
        });

        console.log(`${result.action} ${result.id} ${JSON.stringify(result.title)}`);
      }
    );
}
