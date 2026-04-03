import { Command, InvalidArgumentError, Option } from "commander";

import { RecallService } from "../../core/recall.js";
import type { MemoryType } from "../../core/types.js";

const MEMORY_TYPES = [
  "task_state",
  "preference",
  "project_context",
  "decision",
  "pitfall",
  "insight"
] as const satisfies readonly MemoryType[];

const SORTS = {
  recent: "updated_at DESC",
  importance: "importance DESC",
  accessed: "accessed_at DESC"
} as const;

const parseLimit = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("limit must be a positive integer");
  }

  return parsed;
};

export function registerListCommand(program: Command, recallService: RecallService): void {
  program
    .command("list")
    .description("List memories")
    .option("--project <project>", "project name")
    .addOption(new Option("--type <type>", "memory type").choices([...MEMORY_TYPES]))
    .option("--limit <limit>", "maximum result count", parseLimit, 20)
    .addOption(new Option("--sort <sort>", "sort order").choices(Object.keys(SORTS)).default("recent"))
    .action(
      (options: {
        project?: string;
        type?: MemoryType;
        limit: number;
        sort: keyof typeof SORTS;
      }) => {
        const memories = recallService.listMemories({
          project: options.project,
          type: options.type,
          limit: options.limit,
          sort: SORTS[options.sort]
        });

        if (memories.length === 0) {
          console.log("No memories found.");
          return;
        }

        console.table(
          memories.map((memory) => ({
            id: memory.id,
            title: memory.title,
            project: memory.project,
            type: memory.type,
            importance: Number(memory.importance.toFixed(2)),
            verified: memory.verified,
            status: memory.status,
            accessed: memory.access_count,
            updated_at: memory.updated_at
          }))
        );
      }
    );
}
