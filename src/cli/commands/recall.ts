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

const parseLimit = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("limit must be a positive integer");
  }

  return parsed;
};

const parseSimilarity = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("min-similarity must be a number between 0 and 1");
  }

  return parsed;
};

const serializeResult = (result: Awaited<ReturnType<RecallService["recall"]>>[number]) => ({
  id: result.memory.id,
  title: result.memory.title,
  content: result.memory.content,
  type: result.memory.type,
  project: result.memory.project,
  tags: result.memory.tags,
  importance: result.memory.importance,
  verified: result.memory.verified,
  similarity: result.similarity,
  finalScore: result.finalScore
});

export function registerRecallCommand(program: Command, recallService: RecallService): void {
  program
    .command("recall")
    .description("Recall relevant memories")
    .argument("<query>", "search query")
    .option("--project <project>", "project name")
    .addOption(new Option("--type <type>", "memory type").choices([...MEMORY_TYPES]))
    .option("--limit <limit>", "maximum result count", parseLimit, 5)
    .option(
      "--min-similarity <score>",
      "minimum cosine similarity threshold",
      parseSimilarity,
      0.3
    )
    .option("--json", "print JSON")
    .option("--brief", "print only id and title")
    .action(
      async (
        query: string,
        options: {
          project?: string;
          type?: MemoryType;
          limit: number;
          minSimilarity: number;
          json?: boolean;
          brief?: boolean;
        }
      ) => {
        const results = await recallService.recall(query, {
          project: options.project,
          type: options.type,
          limit: options.limit,
          minSimilarity: options.minSimilarity
        });

        if (options.json) {
          console.log(JSON.stringify(results.map(serializeResult), null, 2));
          return;
        }

        if (results.length === 0) {
          console.log("No memories found.");
          return;
        }

        if (options.brief) {
          for (const result of results) {
            console.log(`${result.memory.id}\t${result.memory.title}`);
          }
          return;
        }

        results.forEach((result, index) => {
          const lines = [
            `[${index + 1}] ${result.memory.title}`,
            `id: ${result.memory.id}`,
            `project: ${result.memory.project}`,
            `type: ${result.memory.type}`,
            `similarity: ${result.similarity.toFixed(3)}`,
            `content: ${result.memory.content}`
          ];

          console.log(lines.join("\n"));
          if (index < results.length - 1) {
            console.log("");
          }
        });
      }
    );
}
