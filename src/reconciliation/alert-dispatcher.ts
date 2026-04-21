import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ReconciliationAlert } from "./alert.js";

export interface AlertDispatcher {
  dispatch(alerts: ReadonlyArray<ReconciliationAlert>, now: Date): Promise<void>;
}

export function createPerDimensionAlertDispatcher(baseDir: string): AlertDispatcher {
  return {
    async dispatch(alerts, now) {
      if (alerts.length === 0) {
        return;
      }

      mkdirSync(baseDir, { recursive: true });

      for (const alert of alerts) {
        const filename = `reconciliation-${alert.dimension}-${alert.severity}.md`;
        writeFileSync(join(baseDir, filename), renderAlertMarkdown(alert, now));
      }
    }
  };
}

function renderAlertMarkdown(alert: ReconciliationAlert, now: Date): string {
  return [
    `# Reconciliation Alert: ${alert.dimension}`,
    "",
    `**Severity**: ${alert.severity.toUpperCase()}`,
    `**Mismatch rate**: ${(alert.mismatch_rate * 100).toFixed(2)}%`,
    `**Threshold exceeded**: ${(alert.threshold_exceeded * 100).toFixed(2)}%`,
    `**Issued at**: ${now.toISOString()}`,
    "",
    alert.summary
  ].join("\n");
}
