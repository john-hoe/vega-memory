import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BACKUP_CONFIG, type BackupConfig } from "../backup/registry.js";
import { BackupScheduler } from "../backup/scheduler.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";

const createConfig = (overrides: Partial<BackupConfig> = {}): BackupConfig => ({
  ...DEFAULT_BACKUP_CONFIG,
  targets: ["/tmp/vega.db"],
  scheduler: {
    enabled: true,
    interval_ms: 86_400_000,
    ...(overrides.scheduler ?? {})
  },
  retention: {
    ...DEFAULT_BACKUP_CONFIG.retention,
    ...(overrides.retention ?? {})
  },
  exclude_globs: overrides.exclude_globs ?? [],
  ...overrides
});

const restoreEnv = (key: "VEGA_BACKUP_INTERVAL_MS" | "VEGA_BACKUP_SCHEDULER_ENABLED", previous: string | undefined) => {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = previous;
};

test("BackupScheduler start is inert when config.scheduler.enabled is false", () => {
  const db = new SQLiteAdapter(":memory:");
  const originalSetInterval = globalThis.setInterval;
  let setCalls = 0;

  globalThis.setInterval = (((_handler: TimerHandler, _timeout?: number) => {
    setCalls += 1;
    return { unref() {} } as NodeJS.Timeout;
  }) as unknown) as typeof setInterval;

  try {
    const scheduler = new BackupScheduler({
      config: createConfig({
        scheduler: {
          enabled: false,
          interval_ms: 10
        }
      }),
      homeDir: "/tmp",
      db
    });

    scheduler.start();

    assert.equal(setCalls, 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
    db.close();
  }
});

test("BackupScheduler start is inert when VEGA_BACKUP_SCHEDULER_ENABLED is false", () => {
  const db = new SQLiteAdapter(":memory:");
  const previousEnv = process.env.VEGA_BACKUP_SCHEDULER_ENABLED;
  const originalSetInterval = globalThis.setInterval;
  let setCalls = 0;

  process.env.VEGA_BACKUP_SCHEDULER_ENABLED = "false";
  globalThis.setInterval = (((_handler: TimerHandler, _timeout?: number) => {
    setCalls += 1;
    return { unref() {} } as NodeJS.Timeout;
  }) as unknown) as typeof setInterval;

  try {
    const scheduler = new BackupScheduler({
      config: createConfig(),
      homeDir: "/tmp",
      db
    });

    scheduler.start();

    assert.equal(setCalls, 0);
  } finally {
    restoreEnv("VEGA_BACKUP_SCHEDULER_ENABLED", previousEnv);
    globalThis.setInterval = originalSetInterval;
    db.close();
  }
});

test("BackupScheduler honors VEGA_BACKUP_INTERVAL_MS and tick invokes the trigger", async () => {
  const db = new SQLiteAdapter(":memory:");
  const previousEnv = process.env.VEGA_BACKUP_INTERVAL_MS;
  const originalSetInterval = globalThis.setInterval;
  let capturedDelay: number | undefined;
  let triggerCalls = 0;

  process.env.VEGA_BACKUP_INTERVAL_MS = "25";
  globalThis.setInterval = (((_handler: TimerHandler, timeout?: number) => {
    capturedDelay = timeout;
    return { unref() {} } as NodeJS.Timeout;
  }) as unknown) as typeof setInterval;

  try {
    const scheduler = new BackupScheduler({
      config: createConfig(),
      homeDir: "/tmp",
      db,
      trigger: async () => {
        triggerCalls += 1;
        return {
          backup_id: "backup-id",
          path: "/tmp/.vega/backups/backup-id",
          file_count: 1,
          total_bytes: 42,
          manifest_sha256: "manifest-hash"
        };
      }
    });

    scheduler.start();
    await scheduler.tick();

    assert.equal(capturedDelay, 25);
    assert.equal(triggerCalls, 1);
  } finally {
    restoreEnv("VEGA_BACKUP_INTERVAL_MS", previousEnv);
    globalThis.setInterval = originalSetInterval;
    db.close();
  }
});

test("BackupScheduler stop clears the interval exactly once", () => {
  const db = new SQLiteAdapter(":memory:");
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let clearCalls = 0;

  globalThis.setInterval = (((_handler: TimerHandler, _timeout?: number) => {
    return { unref() {} } as NodeJS.Timeout;
  }) as unknown) as typeof setInterval;
  globalThis.clearInterval = ((_timer?: NodeJS.Timeout) => {
    clearCalls += 1;
  }) as typeof clearInterval;

  try {
    const scheduler = new BackupScheduler({
      config: createConfig(),
      homeDir: "/tmp",
      db
    });

    scheduler.start();
    scheduler.stop();
    scheduler.stop();

    assert.equal(clearCalls, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    db.close();
  }
});
