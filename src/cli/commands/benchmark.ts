import { Command } from "commander";

import type { VegaConfig } from "../../config.js";
import { buildBenchmarkMarkdown, loadLatestBenchmarkReport, writeBenchmarkArtifacts } from "../../benchmark/report.js";
import { runBenchmarkSuite } from "../../benchmark/runner.js";
import type { BenchmarkReport } from "../../benchmark/types.js";
import type { MemoryService } from "../../core/memory.js";
import type { RecallService } from "../../core/recall.js";
import type { Repository } from "../../db/repository.js";

const printRunSummary = (report: BenchmarkReport): void => {
  console.log(
    [
      `benchmark_run_id: ${report.run_id}`,
      `status: ${report.summary.passed ? "pass" : "fail"}`,
      `checks: ${report.summary.passed_checks}/${report.summary.total_checks}`,
      `recall_engine: ${report.environment.recall_engine}`,
      `json: ${report.files.json}`,
      `markdown: ${report.files.markdown}`
    ].join("\n")
  );
};

const runAndPrintBenchmark = async (config: VegaConfig, json = false): Promise<void> => {
  const report = await runBenchmarkSuite(config);
  writeBenchmarkArtifacts(report);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(buildBenchmarkMarkdown(report));
  printRunSummary(report);
};

const printStoredReport = (config: VegaConfig, json = false): void => {
  const report = loadLatestBenchmarkReport(config);

  if (!report) {
    throw new Error("No benchmark report found. Run `vega benchmark run` first.");
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(buildBenchmarkMarkdown(report));
  printRunSummary(report);
};

export function registerBenchmarkCommand(
  program: Command,
  _repository: Repository,
  _memoryService: MemoryService,
  _recallService: RecallService,
  config: VegaConfig
): void {
  const benchmarkCommand = program
    .command("benchmark")
    .description("Run and inspect Vega Memory benchmark suites");

  benchmarkCommand
    .command("run")
    .description("Run the full benchmark suite and persist JSON/Markdown results")
    .option("--json", "print JSON for the run output")
    .action(async (options: { json?: boolean }) => {
      await runAndPrintBenchmark(config, options.json ?? false);
    });

  benchmarkCommand
    .command("report")
    .description("Print the most recent persisted benchmark report")
    .option("--json", "print JSON instead of Markdown")
    .action((options: { json?: boolean }) => {
      printStoredReport(config, options.json ?? false);
    });
}
