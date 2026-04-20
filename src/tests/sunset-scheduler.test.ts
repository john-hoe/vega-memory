import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SUNSET_CHECK_INTERVAL_MS,
  SunsetScheduler,
  type SunsetEvaluationResult
} from "../sunset/scheduler.js";
import type { SunsetCandidate } from "../sunset/evaluator.js";

const candidate: SunsetCandidate = {
  id: "legacy-store-route",
  type: "api_route",
  target: "POST /memory_store",
  deprecated_since: "2026-01-15",
  criteria: {
    time_based: {
      min_days_since_deprecated: 90
    }
  },
  notification: {
    changelog: true,
    log_level: "warn"
  }
};

const readyResult: SunsetEvaluationResult = {
  candidate_id: "legacy-store-route",
  status: "ready",
  reasons: ["time_based: 95 days elapsed >= 90"],
  evaluated_at: "2026-04-20T00:00:00.000Z"
};

test("SunsetScheduler start schedules ticks and notifies ready candidates once per day", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let capturedHandler: (() => void | Promise<void>) | undefined;
  let capturedDelay: number | undefined;
  let notifierCalls = 0;

  globalThis.setInterval = (((handler: TimerHandler, timeout?: number) => {
    capturedDelay = timeout;
    capturedHandler =
      typeof handler === "function"
        ? async () => {
            await handler();
          }
        : undefined;
    return { unref() {} } as NodeJS.Timeout;
  }) as unknown) as typeof setInterval;
  globalThis.clearInterval = ((_timer?: NodeJS.Timeout) => {}) as typeof clearInterval;

  try {
    const scheduler = new SunsetScheduler({
      registry: async () => [candidate],
      evaluator: async () => [readyResult],
      notifier: async () => {
        notifierCalls += 1;
      },
      intervalMs: 5,
      now: () => new Date("2026-04-20T12:00:00.000Z")
    });

    scheduler.start();
    assert.equal(capturedDelay, 5);
    assert.equal(typeof capturedHandler, "function");

    await capturedHandler?.();
    await scheduler.tick();

    assert.equal(notifierCalls, 1);
    scheduler.stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("SunsetScheduler stop clears the interval and is idempotent", () => {
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
    const scheduler = new SunsetScheduler({
      registry: async () => [candidate],
      evaluator: async () => [readyResult],
      notifier: async () => {}
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

test("SunsetScheduler falls back to the default interval when VEGA_SUNSET_CHECK_INTERVAL_MS is zero", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const previousInterval = process.env.VEGA_SUNSET_CHECK_INTERVAL_MS;
  let capturedDelay: number | undefined;

  globalThis.setInterval = (((_handler: TimerHandler, timeout?: number) => {
    capturedDelay = timeout;
    return { unref() {} } as NodeJS.Timeout;
  }) as unknown) as typeof setInterval;
  globalThis.clearInterval = ((_timer?: NodeJS.Timeout) => {}) as typeof clearInterval;
  process.env.VEGA_SUNSET_CHECK_INTERVAL_MS = "0";

  try {
    const scheduler = new SunsetScheduler({
      registry: async () => [candidate],
      evaluator: async () => [readyResult],
      notifier: async () => {}
    });

    scheduler.start();

    assert.equal(capturedDelay, DEFAULT_SUNSET_CHECK_INTERVAL_MS);
    scheduler.stop();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (previousInterval === undefined) {
      delete process.env.VEGA_SUNSET_CHECK_INTERVAL_MS;
    } else {
      process.env.VEGA_SUNSET_CHECK_INTERVAL_MS = previousInterval;
    }
  }
});
