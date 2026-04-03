import { dirname, join, resolve } from "node:path";

import { Command } from "commander";

import type { VegaConfig } from "../../config.js";
import { exportSnapshot } from "../../core/snapshot.js";
import type { Repository } from "../../db/repository.js";
import { CompactService } from "../../core/compact.js";

const countBy = <T extends string>(values: T[]): Array<{ name: T; count: number }> => {
  const counts = new Map<T, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
};

const getSnapshotPath = (dbPath: string): string =>
  dbPath === ":memory:"
    ? resolve(process.cwd(), "memory-snapshot.md")
    : join(dirname(resolve(dbPath)), "memory-snapshot.md");

export function registerMaintenanceCommands(
  program: Command,
  repository: Repository,
  compactService: CompactService,
  config: VegaConfig
): void {
  program
    .command("compact")
    .description("Merge duplicates and archive stale memories")
    .option("--project <project>", "project name")
    .action((options: { project?: string }) => {
      const result = compactService.compact(options.project);
      console.log(`merged: ${result.merged}`);
      console.log(`archived: ${result.archived}`);
    });

  program
    .command("snapshot")
    .description("Export a markdown snapshot of active memories")
    .action(() => {
      const outputPath = getSnapshotPath(config.dbPath);
      exportSnapshot(repository, outputPath);
      console.log(outputPath);
    });

  program
    .command("stats")
    .description("Show counts by type, project, and status")
    .action(() => {
      const memories = repository.listMemories({
        limit: 1_000_000,
        sort: "created_at DESC"
      });

      console.log(`total memories: ${memories.length}`);
      console.log("by type:");
      console.table(countBy(memories.map((memory) => memory.type)));
      console.log("by project:");
      console.table(countBy(memories.map((memory) => memory.project)));
      console.log("by status:");
      console.table(countBy(memories.map((memory) => memory.status)));
    });
}
