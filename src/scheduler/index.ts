import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { createAPIServer } from "../api/server.js";
import { loadConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";
import { dailyMaintenance, weeklyHealthReport } from "./tasks.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const timestamp = (): string => new Date().toISOString();

const log = (message: string): void => {
  console.log(`[${timestamp()}] ${message}`);
};

const getDataDir = (dbPath: string): string =>
  dbPath === ":memory:" ? resolve(process.cwd(), "data") : dirname(resolve(dbPath));

const ensureSchedulerDirectories = (dbPath: string): void => {
  const dataDir = getDataDir(dbPath);

  for (const directory of ["backups", "reports", "snapshots", "alerts", "logs"]) {
    mkdirSync(join(dataDir, directory), { recursive: true });
  }
};

const isSunday = (value: Date): boolean => value.getDay() === 0;

const getMsUntilNextSunday = (): number => {
  const now = new Date();

  if (isSunday(now)) {
    return 0;
  }

  const nextSunday = new Date(now);
  nextSunday.setDate(now.getDate() + ((7 - now.getDay()) % 7));
  nextSunday.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  return nextSunday.getTime() - now.getTime();
};

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

async function main(): Promise<void> {
  const config = loadConfig();
  ensureSchedulerDirectories(config.dbPath);

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
  const apiServer = createAPIServer(
    {
      repository,
      memoryService,
      recallService,
      sessionService,
      compactService
    },
    config
  );
  const apiPort = await apiServer.start(config.apiPort);
  log(`HTTP API listening on port ${apiPort}`);
  const runDaily = createGuardedRunner("daily maintenance", async () => {
    await dailyMaintenance(repository, compactService, config);
  });
  const runWeekly = createGuardedRunner("weekly health report", async () => {
    if (!isSunday(new Date())) {
      log("Weekly health report skipped because today is not Sunday");
      return;
    }

    await weeklyHealthReport(repository, config, memoryService);
  });

  let shuttingDown = false;
  let weeklyInterval: NodeJS.Timeout | null = null;
  const dailyInterval = setInterval(() => {
    void runDaily();
  }, DAY_MS);
  const weeklyStarter = setTimeout(() => {
    void runWeekly();
    weeklyInterval = setInterval(() => {
      void runWeekly();
    }, WEEK_MS);
  }, getMsUntilNextSunday());

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log(`Received ${signal}, shutting down scheduler`);
    clearInterval(dailyInterval);
    clearTimeout(weeklyStarter);

    if (weeklyInterval !== null) {
      clearInterval(weeklyInterval);
    }

    try {
      await apiServer.stop();
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
  await runDaily();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[${timestamp()}] Scheduler daemon failed: ${message}`);
  process.exit(1);
});
