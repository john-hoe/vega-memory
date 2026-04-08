import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createAPIServer } from "../api/server.js";
import {
  loadConfig,
  requireDatabaseEncryptionKey,
  type VegaConfig
} from "../config.js";
import type { APIRouterServices } from "../api/routes.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { createAdapter } from "../db/adapter-factory.js";
import { Repository } from "../db/repository.js";
import { ContentDistiller } from "../ingestion/distiller.js";
import { ContentFetcher } from "../ingestion/fetcher.js";
import { RSSService } from "../ingestion/rss.js";
import { NotificationManager } from "../notify/manager.js";
import { SearchEngine } from "../search/engine.js";
import { resolveConfiguredEncryptionKey } from "../security/keychain.js";
import { mountDashboard } from "../web/dashboard.js";
import { CrossReferenceService } from "../wiki/cross-reference.js";
import { PageManager } from "../wiki/page-manager.js";
import { SynthesisEngine } from "../wiki/synthesis.js";
import { StalenessService } from "../wiki/staleness.js";
import {
  dailyMaintenance,
  refreshWikiProjection,
  monitorOllamaAvailability,
  weeklyHealthReport
} from "./tasks.js";

const OLLAMA_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SCHEDULER_TICK_INTERVAL_MS = 5 * 60 * 1000;
const DAILY_RUN_HOUR = 4;
const WEEKLY_RUN_HOUR = 3;

const timestamp = (): string => new Date().toISOString();

const log = (message: string): void => {
  console.log(`[${timestamp()}] ${message}`);
};

const isEntrypoint = (): boolean => {
  const entryPath = process.argv[1];

  return typeof entryPath === "string" && import.meta.url === pathToFileURL(entryPath).href;
};

const getDataDir = (dbPath: string): string =>
  dbPath === ":memory:" ? resolve(process.cwd(), "data") : dirname(resolve(dbPath));

const ensureSchedulerDirectories = (dbPath: string): void => {
  const dataDir = getDataDir(dbPath);

  for (const directory of ["backups", "reports", "snapshots", "alerts", "logs"]) {
    mkdirSync(join(dataDir, directory), { recursive: true });
  }
};

const isSameDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

const getWeekKey = (value: Date): string => {
  const sunday = new Date(value);
  sunday.setHours(0, 0, 0, 0);
  sunday.setDate(sunday.getDate() - sunday.getDay());
  return sunday.toISOString().slice(0, 10);
};

export const shouldRunDaily = (currentTime: Date, lastDailyRun: number | null): boolean =>
  currentTime.getHours() === DAILY_RUN_HOUR &&
  (lastDailyRun === null || !isSameDay(new Date(lastDailyRun), currentTime));

export const shouldRunWeekly = (currentTime: Date, lastWeeklyRun: number | null): boolean =>
  currentTime.getDay() === 0 &&
  currentTime.getHours() === WEEKLY_RUN_HOUR &&
  (lastWeeklyRun === null || getWeekKey(new Date(lastWeeklyRun)) !== getWeekKey(currentTime));

const createGuardedRunner = (
  name: string,
  task: () => Promise<void>
): (() => Promise<void>) => {
  let running = false;

  return async () => {
    if (running) {
      log(`${name} skipped because the previous run is still in progress`);
      return;
    }

    running = true;

    try {
      await task();
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[${timestamp()}] ${name} failed: ${message}`);
    } finally {
      running = false;
    }
  };
};

export const startSchedulerApiServer = async (
  services: Omit<APIRouterServices, "config">,
  config: VegaConfig,
  writeLog: (message: string) => void = log
): Promise<
  | {
      apiServer: ReturnType<typeof createAPIServer>;
      apiPort: number;
    }
  | null
> => {
  if (config.apiKey === undefined) {
    writeLog(
      "HTTP API disabled: VEGA_API_KEY not configured. Set VEGA_API_KEY to enable remote access."
    );
    return null;
  }

  const apiServer = createAPIServer(services, config);
  mountDashboard(apiServer.app, services.repository, config);
  const apiPort = await apiServer.start(config.apiPort);
  writeLog(`HTTP API listening on port ${apiPort}`);

  return {
    apiServer,
    apiPort
  };
};

async function main(): Promise<void> {
  const config = loadConfig();
  const repositoryKey = requireDatabaseEncryptionKey(
    config,
    config.dbEncryption ? await resolveConfiguredEncryptionKey(config) : undefined
  );
  ensureSchedulerDirectories(config.dbPath);
  const notificationManager = new NotificationManager(
    config,
    join(getDataDir(config.dbPath), "alerts")
  );

  const repository = new Repository(createAdapter({ ...config, encryptionKey: repositoryKey }));
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
  const pageManager = new PageManager(repository);
  const crossReferenceService = new CrossReferenceService(pageManager);
  const synthesisEngine = new SynthesisEngine(repository, pageManager, config);
  const stalenessService = new StalenessService(pageManager, repository);
  const contentFetcher = new ContentFetcher();
  const contentDistiller = new ContentDistiller(config);
  const rssService = new RSSService(repository);
  const apiRuntime = await startSchedulerApiServer(
    {
      repository,
      memoryService,
      recallService,
      sessionService,
      compactService
    },
    config
  );
  const runDaily = createGuardedRunner("daily maintenance", async () => {
    await dailyMaintenance(repository, compactService, memoryService, config, {
      notificationManager,
      rssService,
      contentFetcher,
      contentDistiller,
      pageManager,
      synthesisEngine,
      crossReferenceService,
      stalenessService
    });
  });
  const runWeekly = createGuardedRunner("weekly health report", async () => {
    await weeklyHealthReport(repository, config, memoryService, notificationManager);
  });
  const runOllamaMonitor = createGuardedRunner("ollama health check", async () => {
    await monitorOllamaAvailability(config, notificationManager);
  });
  const runStartupWikiProjection = createGuardedRunner("wiki projection refresh", async () => {
    const result = await refreshWikiProjection(
      pageManager,
      synthesisEngine,
      crossReferenceService
    );
    log(
      `Wiki projection refresh finished with ${result.synthesized} candidate topics and ${result.spaces_backfilled} space backfills`
    );
  });

  let shuttingDown = false;
  let lastDailyRun: number | null = null;
  let lastWeeklyRun: number | null = null;
  const runScheduledTasks = createGuardedRunner("scheduler tick", async () => {
    const currentTime = new Date();

    if (shouldRunWeekly(currentTime, lastWeeklyRun)) {
      lastWeeklyRun = currentTime.getTime();
      await runWeekly();
    }

    if (shouldRunDaily(currentTime, lastDailyRun)) {
      lastDailyRun = currentTime.getTime();
      await runDaily();
    }
  });
  const schedulerInterval = setInterval(() => {
    void runScheduledTasks();
  }, SCHEDULER_TICK_INTERVAL_MS);
  const ollamaInterval = setInterval(() => {
    void runOllamaMonitor();
  }, OLLAMA_CHECK_INTERVAL_MS);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log(`Received ${signal}, shutting down scheduler`);
    clearInterval(schedulerInterval);
    clearInterval(ollamaInterval);

    try {
      if (apiRuntime !== null) {
        await apiRuntime.apiServer.stop();
      }
    } finally {
      repository.close();
    }

    log("Scheduler stopped");
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  log("Scheduler daemon started");
  await runStartupWikiProjection();
  await runOllamaMonitor();
  await runScheduledTasks();
}

if (isEntrypoint()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[${timestamp()}] Scheduler daemon failed: ${message}`);
    process.exit(1);
  });
}
