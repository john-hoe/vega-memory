import { Command, InvalidArgumentError } from "commander";

import { ArchiveService } from "../../core/archive-service.js";

const parsePositiveInteger = (value: string): number => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("value must be a positive integer");
  }

  return parsed;
};

export function registerArchiveCommands(program: Command, archiveService: ArchiveService): void {
  const archiveCommand = program.command("archive").description("Manage raw archive maintenance");

  archiveCommand
    .command("embed")
    .description("Build deferred embeddings for cold archive records")
    .option("--batch <count>", "records to process", parsePositiveInteger, 50)
    .option("--project <project>", "project name")
    .option("--json", "print JSON")
    .action(
      async (options: { batch: number; project?: string; json?: boolean }) => {
        const result = await archiveService.buildEmbeddings(options.batch, options.project);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`processed: ${result.processed}`);
        console.log(`embedded: ${result.embedded}`);
        console.log(`skipped: ${result.skipped}`);
        console.log(`remaining_without_embedding: ${result.remaining_without_embedding}`);
        console.log(`hash_repair.updated: ${result.hash_repair.updated}`);
        console.log(`hash_repair.duplicates: ${result.hash_repair.duplicates.length}`);
      }
    );

  archiveCommand
    .command("stats")
    .description("Show cold archive size and embedding coverage")
    .option("--project <project>", "project name")
    .option("--json", "print JSON")
    .action((options: { project?: string; json?: boolean }) => {
      const stats = archiveService.getStats(options.project);

      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(`total_count: ${stats.total_count}`);
      console.log(`total_size_mb: ${stats.total_size_mb}`);
      console.log(`with_embedding_count: ${stats.with_embedding_count}`);
      console.log(`without_embedding_count: ${stats.without_embedding_count}`);
      console.log(`missing_hash_count: ${stats.missing_hash_count}`);
    });
}
