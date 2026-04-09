import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, requireDatabaseEncryptionKey } from "./config.js";
import { CompactService } from "./core/compact.js";
import { CompressionService } from "./core/compression.js";
import { KnowledgeGraphService } from "./core/knowledge-graph.js";
import { MemoryService } from "./core/memory.js";
import { ObserverService } from "./core/observer.js";
import { RecallService } from "./core/recall.js";
import { SessionService } from "./core/session.js";
import { createAdapter } from "./db/adapter-factory.js";
import { Repository } from "./db/repository.js";
import { createMCPServer } from "./mcp/server.js";
import { SearchEngine } from "./search/engine.js";
import { resolveConfiguredEncryptionKey } from "./security/keychain.js";
import { VegaSyncClient } from "./sync/client.js";
import { SyncManager } from "./sync/manager.js";
import { PendingQueue } from "./sync/queue.js";

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
  const activeDbPath = config.mode === "client" ? config.cacheDbPath : config.dbPath;
  const repositoryKey = requireDatabaseEncryptionKey(
    config,
    config.dbEncryption ? await resolveConfiguredEncryptionKey(config) : undefined
  );
  ensureDataDirectory(activeDbPath);

  const runtime =
    config.mode === "client"
      ? await (async () => {
          if (!config.serverUrl) {
            throw new Error("VEGA_SERVER_URL is required when VEGA_MODE=client");
          }

          const repository = new Repository(config.cacheDbPath, repositoryKey);
          const client = new VegaSyncClient(config.serverUrl, config.apiKey);
          const queue = new PendingQueue();
          const syncManager = new SyncManager(client, queue, repository);

          client.setPendingQueue(queue);
          client.setCacheRepository(repository);

          await syncManager.syncPending();
          const graphService = new KnowledgeGraphService(repository);

          return {
            repository,
            graphService,
            memoryService: {
              store: (params: Parameters<VegaSyncClient["store"]>[0]) => client.store(params),
              update: (id: string, updates: Parameters<VegaSyncClient["update"]>[1]) =>
                client.update(id, updates),
              delete: (id: string) => client.delete(id)
            },
            recallService: {
              recall: (
                query: Parameters<VegaSyncClient["recall"]>[0],
                options: Parameters<VegaSyncClient["recall"]>[1]
              ) => client.recall(query, options),
              listMemories: (filters: Parameters<VegaSyncClient["list"]>[0]) => client.list(filters)
            },
            sessionService: {
              sessionStart: (
                workingDirectory: Parameters<VegaSyncClient["sessionStart"]>[0],
                taskHint?: Parameters<VegaSyncClient["sessionStart"]>[1],
                _tenantId?: string | null,
                mode?: Parameters<VegaSyncClient["sessionStart"]>[2]
              ) => client.sessionStart(workingDirectory, taskHint, mode),
              sessionEnd: (
                project: Parameters<VegaSyncClient["sessionEnd"]>[0],
                summary: Parameters<VegaSyncClient["sessionEnd"]>[1],
                completedTasks?: Parameters<VegaSyncClient["sessionEnd"]>[2]
              ) => client.sessionEnd(project, summary, completedTasks)
            },
            compactService: {
              compact: (project?: Parameters<VegaSyncClient["compact"]>[0]) =>
                client.compact(project)
            },
            archiveService: {
              deepRecall: (request: Parameters<VegaSyncClient["deepRecall"]>[0]) =>
                client.deepRecall(request)
            },
            healthProvider: () => client.health()
          };
        })()
      : (() => {
          const repository = new Repository(createAdapter({ ...config, encryptionKey: repositoryKey }));
          const searchEngine = new SearchEngine(repository, config);
          const graphService = new KnowledgeGraphService(repository);
          const memoryService = new MemoryService(repository, config, graphService);
          const recallService = new RecallService(repository, searchEngine, config);
          const sessionService = new SessionService(
            repository,
            memoryService,
            recallService,
            config
          );
          const compactService = new CompactService(repository, config);
          const compressionService = new CompressionService(repository, config);
          const observerService = new ObserverService(memoryService, config);

          return {
            repository,
            graphService,
            memoryService,
            recallService,
            sessionService,
            compactService,
            compressionService,
            observerService
          };
        })();
  const server = createMCPServer({
    ...runtime,
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

    runtime.repository.close();

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
    runtime.repository.close();
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
