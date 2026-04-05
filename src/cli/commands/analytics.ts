import { Command, InvalidArgumentError } from "commander";

import { AnalyticsService } from "../../core/analytics.js";

const parseSince = (value: string): string => {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidArgumentError("since must be a valid date");
  }

  return value;
};

export function registerAnalyticsCommand(
  program: Command,
  analyticsService: AnalyticsService
): void {
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
}
