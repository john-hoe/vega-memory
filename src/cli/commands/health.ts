import { Command } from "commander";

import type { VegaConfig } from "../../config.js";
import { getHealthReport } from "../../core/health.js";
import type { RegressionMetricSummary } from "../../core/types.js";
import type { Repository } from "../../db/repository.js";

const formatMetric = (label: string, metric: RegressionMetricSummary): string =>
  `${label}: latest=${metric.latest ?? "n/a"} avg=${metric.average ?? "n/a"} p95=${metric.p95 ?? "n/a"} p99=${metric.p99 ?? "n/a"} count=${metric.count}`;

const shouldFailHealthCommand = (status: "healthy" | "degraded" | "unhealthy"): boolean =>
  status === "degraded" || status === "unhealthy";

export function registerHealthCommand(
  program: Command,
  repository: Repository,
  config: VegaConfig
): void {
  program
    .command("health")
    .description("Show system health")
    .option("--json", "print JSON")
    .option("--regression", "include regression guard metrics")
    .action(async (options: { json?: boolean; regression?: boolean }) => {
      const report = await getHealthReport(repository, config);
      const shouldFail = shouldFailHealthCommand(report.status);

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        if (shouldFail) {
          process.exitCode = 1;
        }
        return;
      }

      console.log(`status: ${report.status}`);
      console.log(`memory count: ${report.memories}`);
      console.log(`db size: ${report.db_size_mb} MB`);
      console.log(`ollama status: ${report.ollama ? "available" : "unavailable"}`);
      console.log(`last backup: ${report.last_backup ?? "none"}`);

      if (report.issues.length > 0) {
        console.log(`issues: ${report.issues.length}`);
        for (const issue of report.issues) {
          console.log(`- ${issue}`);
        }
      }

      if (!options.regression) {
        if (shouldFail) {
          process.exitCode = 1;
        }
        return;
      }

      const regression = report.regression_guard;
      console.log(`regression guard: ${regression.status}`);
      console.log(
        `thresholds: session_token<=${regression.thresholds.max_session_start_token}, recall_latency<=${regression.thresholds.max_recall_latency_ms}ms, recall_similarity>=${regression.thresholds.min_recall_avg_similarity}, top_k_inflation<=${regression.thresholds.max_top_k_inflation_ratio}`
      );
      console.log(
        formatMetric("session_start_token_estimate", regression.token.session_start_token_estimate)
      );
      console.log(
        formatMetric("session_start_token_light", regression.token.session_start_token_by_mode.light)
      );
      console.log(
        formatMetric(
          "session_start_token_standard",
          regression.token.session_start_token_by_mode.standard
        )
      );
      console.log(
        formatMetric("recall_result_token_estimate", regression.token.recall_result_token_estimate)
      );
      console.log(
        formatMetric(
          "token_budget_utilization_session",
          regression.token.token_budget_utilization.session_start
        )
      );
      console.log(
        formatMetric(
          "token_budget_utilization_recall",
          regression.token.token_budget_utilization.recall
        )
      );
      console.log(
        formatMetric("session_start_latency_ms", regression.latency.session_start_latency_ms)
      );
      console.log(formatMetric("recall_latency_ms", regression.latency.recall_latency_ms));
      console.log(formatMetric("embedding_latency_ms", regression.latency.embedding_latency_ms));
      console.log(
        formatMetric("recall_result_count", regression.recall_quality.recall_result_count)
      );
      console.log(
        formatMetric("recall_avg_similarity", regression.recall_quality.recall_avg_similarity)
      );
      console.log(
        formatMetric("recall_top_k_inflation", regression.recall_quality.recall_top_k_inflation)
      );
      console.log(
        `evidence_pull_rate: ${regression.recall_quality.evidence_pull_rate}`
      );

      if (regression.violations.length > 0) {
        console.log("regression violations:");
        for (const violation of regression.violations) {
          console.log(`- ${violation.message}`);
        }
      }

      if (shouldFail) {
        process.exitCode = 1;
      }
    });
}
