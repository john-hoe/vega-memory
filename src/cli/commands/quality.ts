import { Command } from "commander";

import { QualityService } from "../../core/quality.js";
import type { Repository } from "../../db/repository.js";

const now = (): string => new Date().toISOString();

export function registerQualityCommand(
  program: Command,
  qualityService: QualityService,
  repository: Repository
): void {
  program
    .command("quality")
    .description("Score memory quality and optionally degrade low-quality memories")
    .option("--project <project>", "project name")
    .option("--degrade", "reduce importance for low-quality memories")
    .action(async (options: { project?: string; degrade?: boolean }) => {
      const result = await qualityService.scoreBatch(options.project);

      console.log(`total: ${result.total}`);
      console.log(`avg_score: ${result.avg_score.toFixed(3)}`);
      console.log(`low_quality: ${result.low_quality.length}`);

      for (const memory of result.low_quality) {
        const score = qualityService.scoreMemory(memory);
        console.log(`${memory.id} ${score.overall.toFixed(3)} ${JSON.stringify(memory.title)}`);
      }

      if (!options.degrade) {
        return;
      }

      if (!options.project) {
        console.log(`degraded: ${await qualityService.degradeLowQuality()}`);
        return;
      }

      const updated_at = now();

      for (const memory of result.low_quality) {
        repository.updateMemory(memory.id, {
          importance: Math.max(0, memory.importance - 0.1),
          updated_at
        });
      }

      console.log(`degraded: ${result.low_quality.length}`);
    });
}
