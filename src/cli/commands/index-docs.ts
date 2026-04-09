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
  docIndexService: DocIndexService,
  defaultGraphEnabled = false
): void {
  program
    .command("index-docs")
    .description("Index markdown and text documents")
    .argument("<path>", "file or directory to index")
    .option("--project <project>", "project name")
    .option("--ext <extensions>", "comma-separated extensions", parseExtensions, ["md", "txt"])
    .option("--graph", "build the sidecar code/doc graph during indexing", false)
    .option("--incremental", "only process new or modified files", false)
    .option("--status", "show cache-backed incremental status without indexing", false)
    .action(
      async (
        path: string,
        options: {
          project?: string;
          ext: string[];
          graph: boolean;
          incremental: boolean;
          status: boolean;
        }
      ) => {
        const absolutePath = resolve(path);
        const stats = statSync(absolutePath);
        const project =
          options.project ?? basename(stats.isDirectory() ? absolutePath : dirname(absolutePath));
        const graph = options.graph || defaultGraphEnabled;

        if (options.status) {
          if (!stats.isDirectory()) {
            throw new Error("--status is only supported for document directories");
          }

          console.log(JSON.stringify(docIndexService.getDirectoryStatus(absolutePath, options.ext), null, 2));
          return;
        }

        const indexed =
          stats.isDirectory()
            ? await docIndexService.indexDirectory(absolutePath, project, options.ext, {
                graph,
                incremental: options.incremental
              })
            : await docIndexService.indexMarkdown(absolutePath, project, {
                graph,
                incremental: options.incremental
              });

        console.log(`indexed ${indexed} sections`);
      }
    );
}
