import { Command } from "commander";

import { IngestionService } from "../../ingestion/service.js";

const parseTags = (value: string): string[] =>
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

export function registerNoteCommand(program: Command, ingestionService: IngestionService): void {
  program
    .command("note")
    .description("Store a quick note")
    .argument("<content>", "note content")
    .requiredOption("--topic <topic>", "note topic")
    .option("--project <project>", "project name")
    .option("--tags <tags>", "comma-separated tags", parseTags)
    .option("--json", "print JSON")
    .action(
      async (
        content: string,
        options: {
          topic: string;
          project?: string;
          tags?: string[];
          json?: boolean;
        }
      ) => {
        const id = await ingestionService.quickNote(
          content,
          options.topic,
          options.project,
          options.tags
        );

        if (options.json) {
          console.log(JSON.stringify({ id }, null, 2));
          return;
        }

        console.log(id);
      }
    );
}
