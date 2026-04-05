import { statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { Command } from "commander";

import { DocIndexService } from "../../core/doc-index.js";

const parseExtensions = (value: string): string[] =>
  value
    .split(",")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);

export function registerDocIndexCommand(
  program: Command,
  docIndexService: DocIndexService
): void {
  program
    .command("index-docs")
    .description("Index markdown and text documents")
    .argument("<path>", "file or directory to index")
    .option("--project <project>", "project name")
    .option("--ext <extensions>", "comma-separated extensions", parseExtensions, ["md", "txt"])
    .action(
      async (
        path: string,
        options: { project?: string; ext: string[] }
      ) => {
        const absolutePath = resolve(path);
        const stats = statSync(absolutePath);
        const project =
          options.project ?? basename(stats.isDirectory() ? absolutePath : dirname(absolutePath));

        const indexed =
          stats.isDirectory()
            ? await docIndexService.indexDirectory(absolutePath, project, options.ext)
            : await docIndexService.indexMarkdown(absolutePath, project);

        console.log(`indexed ${indexed} sections`);
      }
    );
}
