import type { VegaConfig } from "../config.js";
import {
  isConsolidationAutoExecuteEnabled,
  isConsolidationReportEnabled
} from "../config.js";
import type { Repository } from "../db/repository.js";
import { saveConsolidationReportArtifact } from "./consolidation-runner.js";
import { ConsolidationScheduler } from "./consolidation-scheduler.js";

export class ConsolidationCron {
  private timer: NodeJS.Timeout | null = null;

  private startupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {}

  start(intervalMs: number = 24 * 60 * 60 * 1000): void {
    if (this.timer !== null || this.startupTimer !== null) {
      return;
    }

    if (!(this.config.consolidationCronEnabled ?? false) || !isConsolidationReportEnabled(this.config)) {
      return;
    }

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.runAll();
    }, 5000);
    this.startupTimer.unref();

    this.timer = setInterval(() => {
      this.runAll();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private runAll(): void {
    try {
      const scheduler = new ConsolidationScheduler(this.repository, this.config);
      const pairs = this.repository.listDistinctProjectTenantPairs();

      for (const { project, tenant_id } of pairs) {
        if (!scheduler.shouldTrigger("nightly", project, tenant_id)) {
          continue;
        }

        try {
          const run = scheduler.run(project, tenant_id, {
            trigger: "nightly",
            mode: isConsolidationAutoExecuteEnabled(this.config)
              ? "auto_low_risk"
              : "dry_run"
          });
          saveConsolidationReportArtifact(this.repository, this.config, run);
        } catch (error) {
          console.error(
            `[consolidation-cron] ${project}${tenant_id === null ? "" : ` (${tenant_id})`}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } catch (error) {
      console.error(
        `[consolidation-cron] fatal: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
