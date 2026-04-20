import assert from "node:assert/strict";
import test from "node:test";

import type { Logger } from "../core/logging/index.js";
import type { DetectedTimeout } from "../timeout/detector.js";
import type { TimeoutSweepConfig } from "../timeout/config.js";
import {
  TimeoutSweepScheduler,
  type TimeoutSweepSchedulerOptions
} from "../timeout/scheduler.js";

const createConfig = (overrides: Partial<TimeoutSweepConfig> = {}): TimeoutSweepConfig => ({
  intervalMs: 5_000,
  maxPerRun: 3,
  enabled: true,
  ...overrides
});

const createDetectedTimeout = (
  overrides: Partial<DetectedTimeout> = {}
): DetectedTimeout => ({
  checkpoint_id: "checkpoint-1",
  created_at: 1_000,
  ttl_ms: 30_000,
  expires_at: 31_000,
  host_tier: "T3",
  surface: "codex",
  ...overrides
});

const createLoggerStub = (): {
  logger: Logger;
  warns: Array<{ message: string; context?: Record<string, unknown> }>;
} => {
  const warns: Array<{ message: string; context?: Record<string, unknown> }> = [];

  const logger: Logger = {
    debug() {},
    info() {},
    warn(message, context) {
      warns.push({ message, context });
    },
    error() {},
    withTraceId() {
      return logger;
    }
  };

  return { logger, warns };
};

const createDbStub = (): TimeoutSweepSchedulerOptions["db"] =>
  ({
    isPostgres: false,
    run() {},
    get() {
      return undefined;
    },
    all() {
      return [];
    },
    exec() {},
    prepare() {
      throw new Error("not used");
    },
    transaction(fn) {
      return fn();
    },
    close() {}
  }) as TimeoutSweepSchedulerOptions["db"];

test("TimeoutSweepScheduler start schedules ticks and tick executes detect/classify/record", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let capturedDelay: number | undefined;
  let detectCalls = 0;
  let classifyCalls = 0;
  let recordCalls = 0;

  globalThis.setInterval = (((_handler: TimerHandler, timeout?: number) => {
    capturedDelay = timeout;
    return { unref() {} } as NodeJS.Timeout;
  }) as unknown) as typeof setInterval;
  globalThis.clearInterval = ((_timer?: NodeJS.Timeout) => {}) as typeof clearInterval;

  try {
    const scheduler = new TimeoutSweepScheduler({
      db: createDbStub(),
      config: createConfig({ intervalMs: 75, maxPerRun: 2 }),
      now: () => 9_999,
      detector: (db, options) => {
        assert.equal(db.isPostgres, false);
        assert.deepEqual(options, { now: 9_999, maxPerRun: 2 });
        detectCalls += 1;
        return [createDetectedTimeout()];
      },
      policy: () => {
        classifyCalls += 1;
        return {
          decision: "hard_failure",
          reason: "l1_ttl_expired_tier_t3"
        };
      },
      recorder: (_db, entry) => {
        recordCalls += 1;
        assert.equal(entry.checkpoint_id, "checkpoint-1");
        return {
          written: true,
          reason: "inserted"
        };
      }
    });

    scheduler.start();
    await scheduler.tick();

    assert.equal(capturedDelay, 75);
    assert.equal(detectCalls, 1);
    assert.equal(classifyCalls, 1);
    assert.equal(recordCalls, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("TimeoutSweepScheduler start is inert when config.enabled is false", () => {
  const originalSetInterval = globalThis.setInterval;
  let setCalls = 0;

  globalThis.setInterval = (((_handler: TimerHandler, _timeout?: number) => {
    setCalls += 1;
    return { unref() {} } as NodeJS.Timeout;
  }) as unknown) as typeof setInterval;

  try {
    const scheduler = new TimeoutSweepScheduler({
      db: createDbStub(),
      config: createConfig({ enabled: false })
    });

    scheduler.start();

    assert.equal(setCalls, 0);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("TimeoutSweepScheduler stop clears the interval exactly once", () => {
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
    const scheduler = new TimeoutSweepScheduler({
      db: createDbStub(),
      config: createConfig()
    });

    scheduler.start();
    scheduler.stop();
    scheduler.stop();

    assert.equal(clearCalls, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("TimeoutSweepScheduler tick swallows detector errors and logs a warning", async () => {
  const { logger, warns } = createLoggerStub();
  const scheduler = new TimeoutSweepScheduler({
    db: createDbStub(),
    config: createConfig(),
    logger,
    detector: () => {
      throw new Error("detector failed");
    }
  });

  await assert.doesNotReject(async () => scheduler.tick());
  assert.equal(warns.length, 1);
  assert.match(warns[0]?.message ?? "", /tick failed/i);
});
