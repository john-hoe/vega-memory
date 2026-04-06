import { Command } from "commander";

import { IngestionService, type IngestResult } from "../../ingestion/service.js";

const parseTags = (value: string): string[] =>
  value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

const isUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const printResult = (result: IngestResult): void => {
  console.log(`source_id: ${result.source_id}`);
  console.log(`memories_created: ${result.memories_created}`);
  console.log(`memory_ids: ${result.memory_ids.join(",")}`);
  console.log(`synthesis_queued: ${result.synthesis_queued}`);
};

export function registerIngestCommand(program: Command, ingestionService: IngestionService): void {
  program
    .command("ingest")
    .description("Ingest content from a URL, file path, or clipboard")
    .argument("[url_or_path]", "URL or file path to ingest")
    .option("--clipboard", "ingest clipboard contents")
    .option("--project <project>", "project name")
    .option("--tags <tags>", "comma-separated tags", parseTags)
    .option("--json", "print JSON")
    .action(
      async (
        urlOrPath: string | undefined,
        options: {
          clipboard?: boolean;
          project?: string;
          tags?: string[];
          json?: boolean;
        }
      ) => {
        if (options.clipboard && urlOrPath) {
          throw new Error("Use either <url_or_path> or --clipboard, not both");
        }

        if (!options.clipboard && !urlOrPath) {
          throw new Error("Provide <url_or_path> or use --clipboard");
        }

        const result = await ingestionService.ingest({
          clipboard: options.clipboard,
          url: urlOrPath && isUrl(urlOrPath) ? urlOrPath : undefined,
          filePath: urlOrPath && !isUrl(urlOrPath) ? urlOrPath : undefined,
          project: options.project,
          tags: options.tags
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        printResult(result);
      }
    );
}
