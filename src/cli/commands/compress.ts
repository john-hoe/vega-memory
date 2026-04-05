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
    .option("--memory-id <id>", "compress a single memory by id")
    .option("--project <project>", "project name")
    .option("--min-length <length>", "minimum content length", parseMinLength, 1000)
    .option("--dry-run", "show eligible memories without modifying them")
    .option("--json", "print JSON")
    .action(
      async (options: {
        memoryId?: string;
        project?: string;
        minLength: number;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        if (options.memoryId) {
          const memory = repository.getMemory(options.memoryId);

          if (!memory) {
            throw new Error(`Memory not found: ${options.memoryId}`);
          }

          if (options.dryRun) {
            const result = {
              memory_id: options.memoryId,
              eligible: memory.content.length >= options.minLength,
              original_length: memory.content.length
            };

            if (options.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }

            console.log(`memory_id: ${result.memory_id}`);
            console.log(`eligible: ${result.eligible}`);
            console.log(`original_length: ${result.original_length}`);
            return;
          }

          const result = await compressionService.compressMemory(options.memoryId);
          const output = {
            memory_id: options.memoryId,
            ...result
          };

          if (options.json) {
            console.log(JSON.stringify(output, null, 2));
            return;
          }

          console.log(`memory_id: ${output.memory_id}`);
          console.log(`applied: ${output.applied}`);
          console.log(`original_length: ${output.original_length}`);
          console.log(`compressed_length: ${output.compressed_length}`);
          return;
        }

        if (options.dryRun) {
          const memories = repository
            .listMemories({
              project: options.project,
              status: "active",
              limit: 1_000_000
            })
            .filter((memory) => memory.content.length > options.minLength);

          const result = {
            eligible: memories.length,
            total_chars: memories.reduce((sum, memory) => sum + memory.content.length, 0)
          };

          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log(`eligible: ${result.eligible}`);
          console.log(`total_chars: ${result.total_chars}`);
          return;
        }

        const result = await compressionService.compressBatch(options.project, options.minLength);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`processed: ${result.processed}`);
        console.log(`compressed: ${result.compressed}`);
        console.log(`saved_chars: ${result.saved_chars}`);
      }
    );
}
