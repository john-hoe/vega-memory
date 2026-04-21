import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReconciliationAlertCooldown,
  evaluateReconciliationAlerts,
  type ReconciliationAlertInput
} from "../reconciliation/alert.js";
import { createPerDimensionAlertDispatcher } from "../reconciliation/alert-dispatcher.js";
import { dispatchReconciliationAlerts } from "../scheduler/tasks.js";

const createInput = (overrides: Partial<ReconciliationAlertInput> = {}): ReconciliationAlertInput => ({
  dimension: "count",
  status: "fail",
  mismatch_count: 0,
  compared_count: 100,
  ...overrides
});

test("evaluateReconciliationAlerts returns an empty array for empty findings", () => {
  assert.deepEqual(evaluateReconciliationAlerts([]), []);
});

test("evaluateReconciliationAlerts ignores findings below the warn threshold", () => {
  const alerts = evaluateReconciliationAlerts([
    createInput({
      mismatch_count: 4
    })
  ]);

  assert.deepEqual(alerts, []);
});

test("evaluateReconciliationAlerts emits a warn alert at the warn threshold", () => {
  const alerts = evaluateReconciliationAlerts([
    createInput({
      dimension: "shape",
      mismatch_count: 5
    })
  ]);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.severity, "warn");
  assert.equal(alerts[0]?.dimension, "shape");
  assert.equal(alerts[0]?.threshold_exceeded, 0.05);
});

test("evaluateReconciliationAlerts emits a critical alert at the critical threshold", () => {
  const alerts = evaluateReconciliationAlerts([
    createInput({
      dimension: "semantic",
      mismatch_count: 10
    })
  ]);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.severity, "critical");
  assert.equal(alerts[0]?.dimension, "semantic");
  assert.equal(alerts[0]?.threshold_exceeded, 0.1);
});

test("evaluateReconciliationAlerts returns one alert per dimension above threshold", () => {
  const alerts = evaluateReconciliationAlerts([
    createInput({
      dimension: "count",
      mismatch_count: 6
    }),
    createInput({
      dimension: "ordering",
      mismatch_count: 12
    }),
    createInput({
      dimension: "shape",
      mismatch_count: 1,
      compared_count: 1000
    })
  ]);

  assert.deepEqual(
    alerts.map((alert) => [alert.dimension, alert.severity]),
    [
      ["count", "warn"],
      ["ordering", "critical"]
    ]
  );
});

test("reconciliation alert cooldown suppresses repeat alerts within the flap window", () => {
  const cooldown = createReconciliationAlertCooldown();
  const alert = evaluateReconciliationAlerts([
    createInput({
      dimension: "count",
      mismatch_count: 5
    })
  ])[0];

  assert.ok(alert);
  assert.equal(cooldown.shouldDispatch(alert, 1_000, 3_600_000), true);

  cooldown.record(alert, 1_000);

  assert.equal(cooldown.shouldDispatch(alert, 1_000 + 3_599_999, 3_600_000), false);
  assert.equal(cooldown.shouldDispatch(alert, 1_000 + 3_600_000, 3_600_000), true);
});

test("createPerDimensionAlertDispatcher writes one file per alert dimension and severity", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-reconciliation-alert-dispatch-"));

  try {
    const dispatcher = createPerDimensionAlertDispatcher(tempDir);
    const alerts = evaluateReconciliationAlerts([
      createInput({
        dimension: "count",
        mismatch_count: 6
      }),
      createInput({
        dimension: "semantic",
        mismatch_count: 10
      }),
      createInput({
        dimension: "ordering",
        mismatch_count: 8
      })
    ]);

    await dispatcher.dispatch(alerts, new Date("2026-04-21T12:00:00.000Z"));

    assert.deepEqual(readdirSync(tempDir).sort(), [
      "reconciliation-count-warn.md",
      "reconciliation-ordering-warn.md",
      "reconciliation-semantic-critical.md"
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("dispatchReconciliationAlerts sends one summary notification for multiple alerts", async () => {
  const alerts = evaluateReconciliationAlerts([
    createInput({
      dimension: "count",
      mismatch_count: 6
    }),
    createInput({
      dimension: "semantic",
      mismatch_count: 10
    }),
    createInput({
      dimension: "ordering",
      mismatch_count: 8
    })
  ]);
  const dispatchedBatches: typeof alerts[] = [];
  const warningCalls: Array<{ title: string; detail: string }> = [];

  const dispatched = await dispatchReconciliationAlerts({
    alerts,
    alertDispatcher: {
      async dispatch(batch) {
        dispatchedBatches.push([...batch]);
      }
    },
    notificationManager: {
      async notifyWarning(title, detail) {
        warningCalls.push({ title, detail });
      }
    },
    cooldown: createReconciliationAlertCooldown(),
    cooldownMs: 3_600_000,
    now: Date.parse("2026-04-21T12:00:00.000Z")
  });

  assert.equal(dispatched, 3);
  assert.equal(dispatchedBatches.length, 1);
  assert.equal(dispatchedBatches[0]?.length, 3);
  assert.equal(warningCalls.length, 1);
  assert.equal(warningCalls[0]?.title, "Reconciliation Alerts");
  assert.match(warningCalls[0]?.detail ?? "", /count, semantic, ordering/);
});
