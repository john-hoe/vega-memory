import { createLogger, type Logger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";

import { createBackup, type CreateBackupResult } from "./trigger.js";
import type { BackupConfig } from "./registry.js";

const logger = createLogger({ name: "backup-scheduler" });

export interface BackupSchedulerOptions {
  config: BackupConfig;
  homeDir: string;
  db: DatabaseAdapter;
  trigger?: (options: {
    config: BackupConfig;
    homeDir: string;
    now: Date;
  }) => Promise<CreateBackupResult>;
  intervalMs?: number;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export const resolveBackupIntervalMs = (
  config: BackupConfig,
  env: NodeJS.ProcessEnv = process.env
): number => {
  const parsed = Number.parseInt(env.VEGA_BACKUP_INTERVAL_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : config.scheduler.interval_ms;
};

export class BackupScheduler {
  readonly #config: BackupConfig;
  readonly #homeDir: string;
  readonly #db: DatabaseAdapter;
  readonly #trigger: NonNullable<BackupSchedulerOptions["trigger"]>;
  readonly #intervalMs: number;
  readonly #now: () => Date;
  readonly #env: NodeJS.ProcessEnv;
  readonly #logger: Logger;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: BackupSchedulerOptions) {
    this.#config = options.config;
    this.#homeDir = options.homeDir;
    this.#db = options.db;
    this.#trigger = options.trigger ?? createBackup;
    this.#env = options.env ?? process.env;
    this.#intervalMs = options.intervalMs ?? resolveBackupIntervalMs(options.config, this.#env);
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? logger;
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    if (this.#env.VEGA_BACKUP_SCHEDULER_ENABLED === "false") {
      return;
    }

    if (!this.#config.scheduler.enabled || this.#config.targets.length === 0) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === null) {
      return;
    }

    clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<void> {
    try {
      await this.#trigger({
        config: this.#config,
        homeDir: this.#homeDir,
        now: this.#now()
      });
    } catch (error) {
      this.#logger.warn("Backup scheduler tick failed.", {
        error: error instanceof Error ? error.message : String(error),
        is_postgres: this.#db.isPostgres
      });
    }
  }
}
