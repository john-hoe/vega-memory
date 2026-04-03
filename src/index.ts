import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { CompactService } from "./core/compact.js";
import { MemoryService } from "./core/memory.js";
import { RecallService } from "./core/recall.js";
import { SessionService } from "./core/session.js";
import { Repository } from "./db/repository.js";
import { createMCPServer } from "./mcp/server.js";
import { SearchEngine } from "./search/engine.js";

const ensureDataDirectory = (dbPath: string): void => {
  if (dbPath === ":memory:") {
    return;
  }

  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
};

import { appendFileSync } from "node:fs";

const debugLog = (msg: string) => {
  appendFileSync("/tmp/vega-mcp-debug.log", `${new Date().toISOString()} ${msg}\n`);
};

async function main(): Promise<void> {
  debugLog("main() starting");
  const config = loadConfig();
  ensureDataDirectory(config.dbPath);

  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(
    repository,
    memoryService,
    recallService,
    config
  );
  const compactService = new CompactService(repository, config);
  const server = createMCPServer({
    repository,
    memoryService,
    recallService,
    sessionService,
    compactService,
    config
  });
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (exitCode?: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    try {
      await server.close();
    } catch {}

    repository.close();

    if (exitCode !== undefined) {
      process.exit(exitCode);
    }
  };

  process.once("SIGINT", () => {
    void shutdown(0);
  });
  process.once("SIGTERM", () => {
    void shutdown(0);
  });

  transport.onclose = () => {
    repository.close();
  };
  transport.onerror = (error) => {
    console.error(error);
  };

  debugLog("connecting transport...");
  try {
    await server.connect(transport);
    debugLog("transport connected OK");
  } catch (error) {
    debugLog(`connect error: ${error}`);
    await shutdown();
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
