import { Command, InvalidArgumentError } from "commander";

import { CompressionService } from "../../core/compression.js";
import type { Repository } from "../../db/repository.js";

const parseMinLength = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("min-length must be a positive integer");
  }

  return parsed;
};

export function registerCompressionCommand(
  program: Command,
  compressionService: CompressionService,
  repository: Repository
): void {
  program
    .command("compress")
    .description("Compress long memories with Ollama")
    .option("--project <project>", "project name")
    .option("--min-length <length>", "minimum content length", parseMinLength, 1000)
    .option("--dry-run", "show eligible memories without modifying them")
    .action(
      async (options: { project?: string; minLength: number; dryRun?: boolean }) => {
        if (options.dryRun) {
          const memories = repository
            .listMemories({
              project: options.project,
              status: "active",
              limit: 1_000_000
            })
            .filter((memory) => memory.content.length > options.minLength);

          console.log(`eligible: ${memories.length}`);
          console.log(
            `total_chars: ${memories.reduce((sum, memory) => sum + memory.content.length, 0)}`
          );
          return;
        }

        const result = await compressionService.compressBatch(options.project, options.minLength);

        console.log(`processed: ${result.processed}`);
        console.log(`compressed: ${result.compressed}`);
        console.log(`saved_chars: ${result.saved_chars}`);
      }
    );
}
