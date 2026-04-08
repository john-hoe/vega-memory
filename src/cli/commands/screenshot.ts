import { Command } from "commander";

import { ImageMemoryService } from "../../core/image-memory.js";

export function registerScreenshotCommand(
  program: Command,
  imageMemoryService: ImageMemoryService
): void {
  program
    .command("screenshot")
    .description("Store a screenshot reference as memory")
    .argument("<image-path>", "image file path")
    .option("--description <description>", "screenshot description", "")
    .option("--project <project>", "project name", "global")
    .action(
      async (
        imagePath: string,
        options: { description: string; project: string }
      ) => {
        const memoryId = await imageMemoryService.storeScreenshot(
          imagePath,
          options.description,
          options.project
        );

        console.log(memoryId);
      }
    );
}
