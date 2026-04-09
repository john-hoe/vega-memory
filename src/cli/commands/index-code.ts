import { Command } from "commander";

import { CodeIndexService } from "../../core/code-index.js";

const parseExtensions = (value: string): string[] =>
  value
    .split(",")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);

export function registerCodeIndexCommand(
  program: Command,
  codeIndexService: CodeIndexService,
  defaultGraphEnabled = false
): void {
  program
    .command("index")
    .description("Index source code symbols")
    .argument("<directory>", "directory to index")
    .option("--ext <extensions>", "comma-separated extensions", parseExtensions, ["ts", "js", "py"])
    .option("--graph", "build the sidecar code/doc graph during indexing", false)
    .action(async (directory: string, options: { ext: string[]; graph: boolean }) => {
      const indexedFiles = await codeIndexService.indexDirectory(directory, options.ext, {
        graph: options.graph || defaultGraphEnabled
      });

      console.log(`indexed ${indexedFiles} files`);
    });
}
