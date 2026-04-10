import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { VegaConfig } from "../config.js";
import type { Repository } from "../db/repository.js";
import type {
  ConsolidationPolicyMode,
  ConsolidationRunRecord,
  ConsolidationTrigger
} from "./types.js";
import { ConsolidationScheduler } from "./consolidation-scheduler.js";

export interface ConsolidationRunAllOptions {
  mode?: ConsolidationPolicyMode;
  trigger?: ConsolidationTrigger;
  saveReports?: boolean;
}

export interface ConsolidationRunAllResult {
  mode: ConsolidationPolicyMode;
  trigger: ConsolidationTrigger;
  total_projects: number;
  runs: ConsolidationRunRecord[];
  saved_reports: string[];
}

const DEFAULT_REPORT_DIRECTORY = ["data", "consolidation-reports"];

const sanitizeProjectName = (project: string): string =>
  project.replace(/[^a-zA-Z0-9._-]+/g, "-");

export const getConsolidationReportDirectory = (config: Pick<VegaConfig, "dbPath">): string => {
  if (config.dbPath === ":memory:") {
    return resolve(process.cwd(), ...DEFAULT_REPORT_DIRECTORY);
  }

  return resolve(dirname(resolve(config.dbPath)), "consolidation-reports");
};

export const saveConsolidationReportArtifact = (
  repository: Repository,
  config: Pick<VegaConfig, "dbPath">,
  run: Pick<ConsolidationRunRecord, "project" | "run_id">
): string | null => {
  const reportJson = repository.getConsolidationRunReportJson(run.run_id);

  if (reportJson === null) {
    return null;
  }

  const reportDirectory = getConsolidationReportDirectory(config);
  mkdirSync(reportDirectory, { recursive: true });

  const reportPath = join(
    reportDirectory,
    `${sanitizeProjectName(run.project)}-${run.run_id}.json`
  );
  writeFileSync(reportPath, `${reportJson}\n`, "utf8");

  return reportPath;
};

export const runConsolidationAcrossProjects = (
  repository: Repository,
  config: VegaConfig,
  options: ConsolidationRunAllOptions = {}
): ConsolidationRunAllResult => {
  const scheduler = new ConsolidationScheduler(repository, config);
  const mode = options.mode ?? "dry_run";
  const trigger = options.trigger ?? "nightly";
  const pairs = repository.listDistinctProjectTenantPairs();
  const runs: ConsolidationRunRecord[] = [];
  const savedReports: string[] = [];

  for (const { project, tenant_id } of pairs) {
    const run = scheduler.run(project, tenant_id, { mode, trigger });
    runs.push(run);

    if (options.saveReports) {
      const reportPath = saveConsolidationReportArtifact(repository, config, run);

      if (reportPath !== null) {
        savedReports.push(reportPath);
      }
    }
  }

  return {
    mode,
    trigger,
    total_projects: pairs.length,
    runs,
    saved_reports: savedReports
  };
};
