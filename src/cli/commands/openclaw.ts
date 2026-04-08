import { Command } from "commander";

import { OpenClawClient } from "../../integrations/openclaw.js";

export function registerOpenClawCommands(program: Command, client: OpenClawClient): void {
  const command = program.command("openclaw").description("Interact with the configured OpenClaw backend");

  command
    .command("search")
    .argument("<query>", "search query")
    .option("--limit <limit>", "maximum results", (value) => Number.parseInt(value, 10))
    .option("--type <type>", "optional OpenClaw document type")
    .action(async (query: string, options: { limit?: number; type?: string }) => {
      console.log(JSON.stringify(await client.search(query, options), null, 2));
    });

  command
    .command("get")
    .argument("<id>", "document id")
    .action(async (id: string) => {
      console.log(JSON.stringify(await client.getDocument(id), null, 2));
    });

  command
    .command("ingest")
    .argument("<content>", "content to ingest")
    .option("--meta <key=value...>", "metadata entries", (value, current: string[] = []) => [...current, value], [])
    .action(async (content: string, options: { meta: string[] }) => {
      const metadata = Object.fromEntries(
        options.meta.flatMap((entry) => {
          const [key, value] = entry.split("=", 2);
          return key && value ? [[key, value]] : [];
        })
      );

      console.log(JSON.stringify(await client.ingest(content, metadata), null, 2));
    });
}
