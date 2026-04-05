import { Command } from "commander";

import { QualityService } from "../../core/quality.js";

export function registerQualityCommand(
  program: Command,
  qualityService: QualityService
): void {
  program
    .command("quality")
    .description("Score memory quality and optionally degrade low-quality memories")
    .option("--project <project>", "project name")
    .option("--degrade", "reduce importance for low-quality memories")
    .option("--json", "print JSON")
    .action(async (options: { project?: string; degrade?: boolean; json?: boolean }) => {
      const result = await qualityService.scoreBatch(options.project);
      const lowQualityWithScores = result.low_quality.map((memory) => ({
        id: memory.id,
        title: memory.title,
        score: Number(qualityService.scoreMemory(memory).overall.toFixed(3))
      }));

      let degraded = 0;
      if (options.degrade) {
        degraded = await qualityService.degradeLowQuality(options.project);
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              total: result.total,
              avg_score: Number(result.avg_score.toFixed(3)),
              low_quality: lowQualityWithScores,
              degraded
            },
            null,
            2
          )
        );
        return;
      }

      console.log(`total: ${result.total}`);
      console.log(`avg_score: ${result.avg_score.toFixed(3)}`);
      console.log(`low_quality: ${result.low_quality.length}`);

      for (const entry of lowQualityWithScores) {
        console.log(`${entry.id} ${entry.score.toFixed(3)} ${JSON.stringify(entry.title)}`);
      }

      if (options.degrade) {
        console.log(`degraded: ${degraded}`);
      }
    });
}
