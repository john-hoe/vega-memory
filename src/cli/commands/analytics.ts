import { Command, InvalidArgumentError } from "commander";

import type { VegaConfig } from "../../config.js";
import { AnalyticsService } from "../../core/analytics.js";
import { runDoctor } from "./doctor.js";
import { inspectAllSetupStatuses } from "./setup.js";

const parseSince = (value: string): string => {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidArgumentError("since must be a valid date");
  }

  return value;
};

export function registerAnalyticsCommand(
  program: Command,
  analyticsService: AnalyticsService,
  config: VegaConfig
): void {
  const getSetupSurfaceCoverage = (): Record<string, "configured" | "partial" | "missing"> =>
    inspectAllSetupStatuses().reduce<Record<string, "configured" | "partial" | "missing">>(
      (coverage, status) => {
        coverage[status.target] = status.state;
        return coverage;
      },
      {}
    );

  program
    .command("analytics")
    .description("Show usage analytics")
    .option("--since <date>", "include activity since this date", parseSince)
    .option("--json", "print JSON")
    .action((options: { since?: string; json?: boolean }) => {
      const stats = analyticsService.getUsageStats(undefined, options.since);

      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(`api calls total: ${stats.api_calls_total}`);
      console.log(`avg latency ms: ${stats.avg_latency_ms}`);
      console.log(`memories total: ${stats.memories_total}`);
      console.log(`active projects: ${stats.active_projects}`);
      console.log(`storage bytes: ${stats.storage_bytes}`);
      console.log(`peak hour: ${stats.peak_hour ?? "none"}`);
      console.log(`api calls by operation: ${JSON.stringify(stats.api_calls_by_operation)}`);
      console.log(`memories by type: ${JSON.stringify(stats.memories_by_type)}`);
      console.log(`memories by project: ${JSON.stringify(stats.memories_by_project)}`);
    });

  program
    .command("impact")
    .description("Show the current impact snapshot")
    .option("--days <days>", "window size in days", parseDays, 7)
    .option("--json", "print JSON")
    .action(async (options: { days: number; json?: boolean }) => {
      const doctor = await runDoctor(config);
      const report = analyticsService.getImpactReport({
        days: options.days,
        runtimeReadiness: doctor.status,
        setupSurfaceCoverage: getSetupSurfaceCoverage()
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(`generated at: ${report.generated_at}`);
      console.log(`window days: ${report.window_days}`);
      console.log(`runtime readiness: ${report.runtime_readiness ?? "unknown"}`);
      console.log(`new memories this week: ${report.new_memories_this_week}`);
      console.log(`active projects: ${report.usage.active_projects}`);
      console.log(`api calls total: ${report.usage.api_calls_total}`);
      console.log(`avg latency ms: ${report.usage.avg_latency_ms}`);
      console.log(`setup surface coverage: ${JSON.stringify(report.setup_surface_coverage ?? {})}`);
      console.log(
        `top reused memories (${report.top_reused_memories_basis}): ${JSON.stringify(report.top_reused_memories)}`
      );
    });

  program
    .command("weekly")
    .description("Show the weekly impact summary")
    .option("--days <days>", "window size in days", parseDays, 7)
    .option("--json", "print JSON")
    .action((options: { days: number; json?: boolean }) => {
      const summary = analyticsService.getWeeklySummary({
        days: options.days
      });

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log(`generated at: ${summary.generated_at}`);
      console.log(`window days: ${summary.window_days}`);
      console.log(`new memories this week: ${summary.new_memories_this_week}`);
      console.log(`active projects: ${summary.active_projects}`);
      console.log(`api calls total: ${summary.api_calls_total}`);
      console.log(`avg latency ms: ${summary.avg_latency_ms}`);
      console.log(`peak hour: ${summary.peak_hour ?? "none"}`);
      console.log(`memory mix: ${JSON.stringify(summary.memory_mix)}`);
      console.log(`result type hits: ${JSON.stringify(summary.result_type_hits)}`);
      console.log(
        `top reused memories (${summary.top_reused_memories_basis}): ${JSON.stringify(summary.top_reused_memories)}`
      );
      console.log(`top search queries: ${JSON.stringify(summary.top_search_queries)}`);
    });
}

const parseDays = (value: string): number => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("days must be a positive integer");
  }

  return parsed;
};
