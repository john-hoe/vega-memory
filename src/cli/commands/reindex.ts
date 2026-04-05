import { Command } from "commander";

import { SearchEngine } from "../../search/engine.js";

export function registerReindexCommand(program: Command, searchEngine: SearchEngine): void {
  program
    .command("reindex")
    .description("Force rebuild the sqlite-vec vector index")
    .action(() => {
      const indexed = searchEngine.rebuildIndex();
      console.log(`indexed_embeddings: ${indexed}`);
    });
}
