import assert from "node:assert/strict";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { ALERT_HISTORY_TABLE, AlertScheduler, type AlertEvaluation, type AlertRule } from "../alert/index.js";

const rule: AlertRule = {
  id: "circuit_breaker_open",
  severity: "critical",
  metric: "vega_circuit_breaker_state",
  operator: ">",
  threshold: 0,
  window_ms: 120_000,
  min_duration_ms: 0,
  channels: ["default_webhook"]
};

test("AlertScheduler start schedules ticks and firing alerts are dispatched and recorded", async () => {
  const db = new SQLiteAdapter(":memory:");
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let capturedDelay: number | undefined;
  const dispatched: string[] = [];

  globalThis.setInterval = (((_handler: TimerHandler, timeout?: number) => {
    capturedDelay = timeout;
    return { unref() {} } as NodeJS.Timeout;
  }) as unknown) as typeof setInterval;
  globalThis.clearInterval = ((_timer?: NodeJS.Timeout) => {}) as typeof clearInterval;

  try {
    const scheduler = new AlertScheduler({
      db,
      rules: [rule],
      channels: [
        {
          id: "default_webhook",
          send: async () => {
            dispatched.push("default_webhook");
            return {
              status: "ok"
            };
          }
        }
      ],
      evaluator: async (): Promise<AlertEvaluation[]> => [
        {
          rule_id: "circuit_breaker_open",
          state: "firing",
          value: 1,
          reasons: ["threshold_crossed"],
          evaluated_at: "2026-04-20T00:00:00.000Z"
        }
      ],
      intervalMs: 5,
      cooldownMs: 60_000,
      now: () => new Date("2026-04-20T00:00:00.000Z")
    });

    scheduler.start();
    await scheduler.tick();

    assert.equal(capturedDelay, 5);
    assert.deepEqual(dispatched, ["default_webhook"]);
    assert.equal(
      db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${ALERT_HISTORY_TABLE}`)?.count,
      1
    );
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    db.close();
  }
});

test("AlertScheduler cooldown de-dupes consecutive firing ticks", async () => {
  const db = new SQLiteAdapter(":memory:");
  let dispatchCount = 0;

  try {
    const scheduler = new AlertScheduler({
      db,
      rules: [rule],
      channels: [
        {
          id: "default_webhook",
          send: async () => {
            dispatchCount += 1;
            return {
              status: "ok"
            };
          }
        }
      ],
      evaluator: async (): Promise<AlertEvaluation[]> => [
        {
          rule_id: "circuit_breaker_open",
          state: "firing",
          value: 1,
          reasons: ["threshold_crossed"],
          evaluated_at: "2026-04-20T00:00:00.000Z"
        }
      ],
      cooldownMs: 60_000,
      now: () => new Date("2026-04-20T00:00:00.000Z")
    });

    await scheduler.tick();
    await scheduler.tick();

    assert.equal(dispatchCount, 1);
  } finally {
    db.close();
  }
});

test("AlertScheduler marks the latest firing row resolved when evaluation resolves", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    let evaluations: AlertEvaluation[] = [
      {
        rule_id: "circuit_breaker_open",
        state: "firing",
        value: 1,
        reasons: ["threshold_crossed"],
        evaluated_at: "2026-04-20T00:00:00.000Z"
      }
    ];
    const scheduler = new AlertScheduler({
      db,
      rules: [rule],
      channels: [
        {
          id: "default_webhook",
          send: async () => ({
            status: "ok"
          })
        }
      ],
      evaluator: async () => evaluations,
      cooldownMs: 60_000,
      now: () => new Date("2026-04-20T00:00:00.000Z")
    });

    await scheduler.tick();
    evaluations = [
      {
        rule_id: "circuit_breaker_open",
        state: "resolved",
        value: 0,
        reasons: ["threshold_not_crossed"],
        evaluated_at: "2026-04-20T00:01:00.000Z"
      }
    ];
    await scheduler.tick();

    assert.equal(
      db.get<{ resolved_at: number | null }>(
        `SELECT resolved_at FROM ${ALERT_HISTORY_TABLE} WHERE rule_id = ?`,
        "circuit_breaker_open"
      )?.resolved_at,
      Date.parse("2026-04-20T00:00:00.000Z")
    );
  } finally {
    db.close();
  }
});

test("AlertScheduler stop clears the interval and is idempotent", () => {
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
    const scheduler = new AlertScheduler({
      db,
      rules: [rule],
      channels: [],
      evaluator: async () => []
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
