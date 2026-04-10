import { Command } from "commander";

import { isConsolidationReportEnabled, type VegaConfig } from "../../config.js";
import { ConsolidationApprovalService } from "../../core/consolidation-approval.js";
import { ConsolidationDashboardService } from "../../core/consolidation-dashboard.js";
import { registerDefaultConsolidationDetectors } from "../../core/consolidation-defaults.js";
import { ConsolidationReportEngine } from "../../core/consolidation-report-engine.js";
import { ConsolidationScheduler } from "../../core/consolidation-scheduler.js";
import type {
  ApprovalItem,
  ConsolidationDashboardMetrics,
  ConsolidationCandidateKind,
  ConsolidationReport,
  ConsolidationRunRecord,
  ConsolidationReportSection
} from "../../core/types.js";
import type { Repository } from "../../db/repository.js";

const REPORT_SECTION_DEFINITIONS: Array<{
  kind: ConsolidationCandidateKind;
  heading: string;
}> = [
  { kind: "duplicate_merge", heading: "Duplicate Merge Candidates" },
  { kind: "expired_fact", heading: "Expired Fact Candidates" },
  { kind: "global_promotion", heading: "Global Promotion Candidates" },
  { kind: "wiki_synthesis", heading: "Wiki Synthesis Candidates" },
  { kind: "conflict_aggregation", heading: "Conflict Aggregation Candidates" }
];

export const formatReportAsMarkdown = (report: ConsolidationReport): string => {
  const lines = [
    `# Consolidation Report: ${report.execution.project}`,
    `Run: ${report.execution.run_id} | ${report.execution.started_at} | ${report.execution.duration_ms}ms`,
    "",
    "## Summary",
    `Total candidates: ${report.summary.total_candidates} (low: ${report.summary.low_risk}, medium: ${report.summary.medium_risk}, high: ${report.summary.high_risk})`
  ];

  if (report.execution.errors.length > 0) {
    lines.push("", "## Errors", ...report.execution.errors.map((error) => `- ${error}`));
  }

  for (const definition of REPORT_SECTION_DEFINITIONS) {
    lines.push("", `## ${definition.heading}`);
    const section = findSection(report.sections, definition.kind);

    if (section === undefined) {
      lines.push("(none - detector not yet registered)");
      continue;
    }

    if (section.candidates.length === 0) {
      lines.push("(none)");
      continue;
    }

    for (const candidate of section.candidates) {
      lines.push(
        `- [${candidate.risk}] ${candidate.description} (action: ${candidate.action}, score: ${candidate.score})`
      );

      if (candidate.memory_ids.length > 0) {
        lines.push(`  memories: ${candidate.memory_ids.join(", ")}`);
      }

      if (candidate.fact_claim_ids.length > 0) {
        lines.push(`  fact claims: ${candidate.fact_claim_ids.join(", ")}`);
      }

      if (candidate.evidence.length > 0) {
        lines.push(`  evidence: ${candidate.evidence.join(" | ")}`);
      }
    }
  }

  return lines.join("\n");
};

const formatApprovalItemAsMarkdown = (item: ApprovalItem): string =>
  [
    `- ${item.id} [${item.status}] ${item.description}`,
    `  kind=${item.candidate_kind} action=${item.candidate_action} risk=${item.candidate_risk} score=${item.score}`,
    item.memory_ids.length > 0 ? `  memories=${item.memory_ids.join(", ")}` : "",
    item.fact_claim_ids.length > 0 ? `  fact_claims=${item.fact_claim_ids.join(", ")}` : "",
    item.reviewed_by ? `  reviewed_by=${item.reviewed_by} at ${item.reviewed_at}` : "",
    item.review_comment ? `  comment=${item.review_comment}` : ""
  ]
    .filter((line) => line.length > 0)
    .join("\n");

export const formatDashboardAsMarkdown = (
  dashboard: ConsolidationDashboardMetrics
): string =>
  [
    `# Consolidation Dashboard: ${dashboard.project}`,
    `Generated: ${dashboard.generated_at}`,
    "",
    "## Memory Stats",
    `Active: ${dashboard.memory_stats.total_active} | Archived: ${dashboard.memory_stats.total_archived} | Conflicts: ${dashboard.memory_stats.conflict_count}`,
    `By scope: project=${dashboard.memory_stats.by_scope.project}, global=${dashboard.memory_stats.by_scope.global}`,
    `By type: ${Object.entries(dashboard.memory_stats.by_type)
      .map(([type, count]) => `${type}=${count}`)
      .join(", ") || "(none)"}`,
    "",
    "## Fact Claim Stats",
    `Active: ${dashboard.fact_claim_stats.total_active} | Expired: ${dashboard.fact_claim_stats.expired} | Suspected expired: ${dashboard.fact_claim_stats.suspected_expired} | Conflict: ${dashboard.fact_claim_stats.conflict}`,
    "",
    "## Topic Stats",
    `Topics: ${dashboard.topic_stats.total_topics} | Topics with memories: ${dashboard.topic_stats.topics_with_memories} | Avg memories/topic: ${dashboard.topic_stats.avg_memories_per_topic}`,
    "",
    "## Health Indicators",
    `Duplicate density: ${dashboard.health_indicators.duplicate_density}`,
    `Stale fact ratio: ${dashboard.health_indicators.stale_fact_ratio}`,
    `Conflict backlog: ${dashboard.health_indicators.conflict_backlog}`,
    `Global promotion pending: ${dashboard.health_indicators.global_promotion_pending}`,
    "",
    "## Consolidation History",
    `Last report: ${dashboard.consolidation_history.last_report_at ?? "none"}`,
    `Reports: ${dashboard.consolidation_history.total_reports_generated} | Candidates found: ${dashboard.consolidation_history.total_candidates_found} | Candidates resolved: ${dashboard.consolidation_history.total_candidates_resolved}`,
    "",
    "## Approval Queue",
    `Pending: ${dashboard.approval_stats.pending} | Approved: ${dashboard.approval_stats.approved_total} | Rejected: ${dashboard.approval_stats.rejected_total}`
  ].join("\n");

const formatRunRecordAsMarkdown = (record: ConsolidationRunRecord): string =>
  [
    `# Consolidation Run: ${record.project}`,
    `Run: ${record.run_id}`,
    `Trigger: ${record.trigger} | Mode: ${record.mode}`,
    `Started: ${record.started_at}`,
    `Completed: ${record.completed_at}`,
    `Duration: ${record.duration_ms}ms`,
    `Candidates: ${record.total_candidates}`,
    `Actions executed: ${record.actions_executed} | Actions skipped: ${record.actions_skipped}`,
    `Errors: ${record.errors.length === 0 ? "(none)" : record.errors.join(" | ")}`
  ].join("\n");

const findSection = (
  sections: ConsolidationReportSection[],
  kind: ConsolidationCandidateKind
): ConsolidationReportSection | undefined =>
  sections.find((section) => section.kind === kind);

export function registerConsolidationReportCommand(
  program: Command,
  repository: Repository,
  config: VegaConfig
): void {
  program
    .command("consolidation-report")
    .description("Generate a dry-run consolidation report")
    .requiredOption("--project <project>", "project name")
    .option("--tenant <tenant>", "tenant ID")
    .option("--json", "output as JSON instead of markdown")
    .action((options: { project: string; tenant?: string; json?: boolean }) => {
      if (!isConsolidationReportEnabled(config)) {
        console.error(
          "consolidation_report feature is disabled. Set features.consolidationReport=true"
        );
        process.exitCode = 1;
        return;
      }

      const engine = new ConsolidationReportEngine(repository, config);
      registerDefaultConsolidationDetectors(engine);
      const report = engine.generateReport(options.project, options.tenant);

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(formatReportAsMarkdown(report));
    });

  program
    .command("consolidation-dashboard")
    .description("Generate consolidation health metrics for a project")
    .requiredOption("--project <project>", "project name")
    .option("--tenant <tenant>", "tenant ID")
    .option("--json", "output as JSON instead of markdown")
    .action((options: { project: string; tenant?: string; json?: boolean }) => {
      if (!isConsolidationReportEnabled(config)) {
        console.error(
          "consolidation_report feature is disabled. Set features.consolidationReport=true"
        );
        process.exitCode = 1;
        return;
      }

      const dashboard = new ConsolidationDashboardService(repository, config).generateDashboard(
        options.project,
        options.tenant
      );

      if (options.json) {
        console.log(JSON.stringify(dashboard, null, 2));
        return;
      }

      console.log(formatDashboardAsMarkdown(dashboard));
    });

  program
    .command("consolidation-run")
    .description("Execute a consolidation run for a project")
    .requiredOption("--project <project>", "project name")
    .option("--tenant <tenant>", "tenant ID")
    .option("--mode <mode>", "run mode: dry_run or auto_low_risk", "dry_run")
    .option(
      "--trigger <trigger>",
      "trigger source: manual, nightly, after_writes, after_session_end",
      "manual"
    )
    .option("--json", "output as JSON instead of markdown")
    .action(
      (options: {
        project: string;
        tenant?: string;
        mode?: "dry_run" | "auto_low_risk";
        trigger?: "manual" | "nightly" | "after_writes" | "after_session_end";
        json?: boolean;
      }) => {
        if (!isConsolidationReportEnabled(config)) {
          console.error(
            "consolidation_report feature is disabled. Set features.consolidationReport=true"
          );
          process.exitCode = 1;
          return;
        }

        const scheduler = new ConsolidationScheduler(repository, config);
        const runRecord = scheduler.run(options.project, options.tenant, {
          mode: options.mode,
          trigger: options.trigger
        });

        if (options.json) {
          console.log(JSON.stringify(runRecord, null, 2));
          return;
        }

        console.log(formatRunRecordAsMarkdown(runRecord));
      }
    );

  const approvals = program
    .command("consolidation-approvals")
    .description("Manage consolidation approval items");

  approvals
    .command("list")
    .description("List consolidation approval items")
    .requiredOption("--project <project>", "project name")
    .option("--tenant <tenant>", "tenant ID")
    .option(
      "--status <status>",
      "status: pending, approved, approved_pending_execution, execution_failed, rejected, expired",
      "pending"
    )
    .option("--limit <limit>", "maximum items to return", "100")
    .option("--json", "output as JSON instead of markdown")
    .action(
      (options: {
        project: string;
        tenant?: string;
        status?: ApprovalItem["status"];
        limit?: string;
        json?: boolean;
      }) => {
        if (!isConsolidationReportEnabled(config)) {
          console.error(
            "consolidation_report feature is disabled. Set features.consolidationReport=true"
          );
          process.exitCode = 1;
          return;
        }

        const approvalService = new ConsolidationApprovalService(repository);
        const items = approvalService.listAll(
          options.project,
          options.status,
          options.tenant,
          Number(options.limit ?? "100")
        );

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
          return;
        }

        if (items.length === 0) {
          console.log("(none)");
          return;
        }

        console.log(items.map(formatApprovalItemAsMarkdown).join("\n"));
      }
    );

  approvals
    .command("review")
    .description("Approve or reject a consolidation approval item")
    .requiredOption("--id <id>", "approval item ID")
    .requiredOption("--status <status>", "approved or rejected")
    .requiredOption("--by <name>", "reviewer name")
    .option("--comment <comment>", "review comment")
    .option("--auto-execute", "execute supported approved actions immediately")
    .option("--json", "output as JSON instead of markdown")
    .action(
      (options: {
        id: string;
        status: "approved" | "rejected";
        by: string;
        comment?: string;
        autoExecute?: boolean;
        json?: boolean;
      }) => {
        if (!isConsolidationReportEnabled(config)) {
          console.error(
            "consolidation_report feature is disabled. Set features.consolidationReport=true"
          );
          process.exitCode = 1;
          return;
        }

        const approvalService = new ConsolidationApprovalService(repository);
        const item = approvalService.review(
          {
            item_id: options.id,
            status: options.status,
            reviewed_by: options.by,
            ...(options.comment ? { comment: options.comment } : {})
          },
          options.autoExecute ?? false
        );

        if (options.json) {
          console.log(JSON.stringify(item, null, 2));
          return;
        }

        console.log(formatApprovalItemAsMarkdown(item));
      }
    );

  approvals
    .command("retry")
    .description("Retry execution of a failed consolidation approval item")
    .requiredOption("--id <id>", "approval item ID")
    .requiredOption("--by <name>", "retry actor name")
    .option("--json", "output as JSON instead of markdown")
    .action(
      (options: {
        id: string;
        by: string;
        json?: boolean;
      }) => {
        if (!isConsolidationReportEnabled(config)) {
          console.error(
            "consolidation_report feature is disabled. Set features.consolidationReport=true"
          );
          process.exitCode = 1;
          return;
        }

        const approvalService = new ConsolidationApprovalService(repository);
        const item = approvalService.retry(options.id, options.by);

        if (options.json) {
          console.log(JSON.stringify(item, null, 2));
          return;
        }

        console.log(formatApprovalItemAsMarkdown(item));
      }
    );
}
