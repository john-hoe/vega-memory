import { Command } from "commander";

import { isConsolidationReportEnabled, type VegaConfig } from "../../config.js";
import { ConsolidationReportEngine } from "../../core/consolidation-report-engine.js";
import type {
  ConsolidationCandidateKind,
  ConsolidationReport,
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
      const report = engine.generateReport(options.project, options.tenant);

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(formatReportAsMarkdown(report));
    });
}

const findSection = (
  sections: ConsolidationReportSection[],
  kind: ConsolidationCandidateKind
): ConsolidationReportSection | undefined =>
  sections.find((section) => section.kind === kind);
