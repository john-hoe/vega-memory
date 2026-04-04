import { Command } from "commander";

import type { VegaConfig } from "../../config.js";
import { DiagnoseService } from "../../core/diagnose.js";
import type { Repository } from "../../db/repository.js";

export function registerDiagnoseCommand(
  program: Command,
  repository: Repository,
  config: VegaConfig
): void {
  const diagnoseService = new DiagnoseService(repository, config);

  program
    .command("diagnose")
    .description("Run a diagnostic report for Vega Memory")
    .option("--issue <issue>", "issue description to investigate")
    .action(async (options: { issue?: string }) => {
      const report = await diagnoseService.diagnose(options.issue);

      console.log(report.summary);
      console.log(`report: ${report.report_path}`);
      console.log(`can auto fix: ${report.can_auto_fix ? "yes" : "no"}`);

      if (report.issues_found.length > 0) {
        console.log("issues found:");
        for (const issue of report.issues_found) {
          console.log(`- ${issue}`);
        }
      }

      if (report.suggested_fixes.length > 0) {
        console.log("suggested fixes:");
        for (const fix of report.suggested_fixes) {
          console.log(`- ${fix}`);
        }
      }

      console.log("handoff prompt:");
      console.log(report.handoff_prompt);
    });
}
