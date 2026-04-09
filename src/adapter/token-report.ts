import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

import type { VegaConfig } from "../config.js";
import { ArchiveService } from "../core/archive-service.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type {
  Memory,
  SessionStartCanonicalMode,
  SessionStartResult
} from "../core/types.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";

export const ADAPTER_TOKEN_REPORT_MODES = [
  "L0",
  "L1",
  "L2",
  "L3"
] as const satisfies readonly SessionStartCanonicalMode[];

export type AdapterTokenReportMode = (typeof ADAPTER_TOKEN_REPORT_MODES)[number];

export interface AdapterTokenModeMeasurement {
  token_estimate: number;
  latency_ms: number;
  item_count: number;
  deep_recall_results: number;
}

export interface AdapterTokenDelta {
  from: AdapterTokenReportMode;
  to: AdapterTokenReportMode;
  delta_tokens: number;
  delta_ratio: number | null;
}

export interface AdapterTokenReport {
  generated_at: string;
  task_hint: string;
  token_budget: number;
  project: string;
  modes: Record<AdapterTokenReportMode, AdapterTokenModeMeasurement>;
  deltas: AdapterTokenDelta[];
  savings_vs_l3_pct: Record<AdapterTokenReportMode, number | null>;
}

export const DEFAULT_ADAPTER_TOKEN_REPORT_TASK_HINT = "adapter evidence";

const NOW = "2026-04-10T00:00:00.000Z";

const round = (value: number): number => Number(value.toFixed(3));

const countSessionItems = (result: SessionStartResult): number =>
  result.active_tasks.length +
  result.preferences.length +
  result.context.length +
  result.relevant.length +
  result.relevant_wiki_pages.length +
  result.recent_unverified.length +
  result.conflicts.length +
  (result.graph_report === undefined ? 0 : 1) +
  (result.deep_recall?.results.length ?? 0);

const buildMemory = (
  id: string,
  project: string,
  overrides: Partial<Memory> = {}
): Memory => ({
  id,
  tenant_id: null,
  type: "decision",
  project,
  title: id,
  content: `${id} adapter report content`,
  summary: null,
  embedding: null,
  importance: 0.75,
  source: "explicit",
  tags: ["adapter"],
  created_at: NOW,
  updated_at: NOW,
  accessed_at: NOW,
  access_count: 0,
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: [project],
  ...overrides
});

const seedAdapterDataset = (
  repository: Repository,
  archiveService: ArchiveService,
  project: string
): void => {
  const memories = [
    buildMemory("pref-adapter", "shared", {
      type: "preference",
      scope: "global",
      title: "Prefer the smallest safe preload",
      content: "Prefer the smallest safe preload, then fetch more with recall.",
      importance: 0.95,
      accessed_projects: [project]
    }),
    buildMemory("task-adapter", project, {
      type: "task_state",
      title: "Validate adapter flows",
      content: "Validate Claude Code, OpenClaw, and Hermes adapter flows.",
      importance: 0.9
    }),
    buildMemory("context-adapter", project, {
      type: "project_context",
      title: "Adapter protocol context",
      content: "The adapter protocol uses session_start preload plus targeted recall.",
      importance: 0.88
    }),
    buildMemory("conflict-adapter", project, {
      type: "decision",
      title: "Adapter conflict",
      content: "Two adapter loaders disagree on token budget handling.",
      verified: "conflict",
      importance: 0.82
    }),
    buildMemory("unverified-adapter", project, {
      type: "decision",
      title: "Unverified adapter note",
      content: "Need to confirm adapter mode defaults before rollout.",
      verified: "unverified",
      importance: 0.78
    }),
    buildMemory("warning-adapter", project, {
      type: "insight",
      title: "Adapter warning",
      content: "Adapter token pressure should bias toward L0 plus recall.",
      tags: ["adapter", "evidence"],
      importance: 0.8
    }),
    buildMemory("relevant-adapter", "shared", {
      type: "decision",
      scope: "global",
      title: "Adapter recall policy",
      content: "Use recall for task-specific evidence instead of widening preload.",
      importance: 0.86,
      accessed_projects: [project]
    }),
    buildMemory("evidence-adapter", project, {
      type: "decision",
      title: "Adapter evidence source",
      content: "Hot summary for adapter evidence review and restore commands.",
      importance: 0.84
    })
  ];

  for (const memory of memories) {
    repository.createMemory(memory);
  }

  archiveService.store(
    "Full adapter evidence log with archived restore commands and provenance details.",
    "tool_log",
    project,
    {
      source_memory_id: "evidence-adapter",
      title: "Adapter evidence archive"
    }
  );
};

const buildDelta = (
  from: AdapterTokenReportMode,
  to: AdapterTokenReportMode,
  modes: Record<AdapterTokenReportMode, AdapterTokenModeMeasurement>
): AdapterTokenDelta => {
  const deltaTokens = modes[to].token_estimate - modes[from].token_estimate;

  return {
    from,
    to,
    delta_tokens: deltaTokens,
    delta_ratio:
      modes[from].token_estimate === 0
        ? null
        : round(deltaTokens / modes[from].token_estimate)
  };
};

const buildSavingsVsL3 = (
  modes: Record<AdapterTokenReportMode, AdapterTokenModeMeasurement>
): Record<AdapterTokenReportMode, number | null> => {
  const l3Tokens = modes.L3.token_estimate;

  return {
    L0: l3Tokens === 0 ? null : round(((l3Tokens - modes.L0.token_estimate) / l3Tokens) * 100),
    L1: l3Tokens === 0 ? null : round(((l3Tokens - modes.L1.token_estimate) / l3Tokens) * 100),
    L2: l3Tokens === 0 ? null : round(((l3Tokens - modes.L2.token_estimate) / l3Tokens) * 100),
    L3: l3Tokens === 0 ? null : 0
  };
};

export const createAdapterTokenReport = async (
  config: VegaConfig,
  taskHint = DEFAULT_ADAPTER_TOKEN_REPORT_TASK_HINT
): Promise<AdapterTokenReport> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-adapter-token-report-"));
  const workingDirectory = join(tempDir, "workspace", "adapter-token-report");
  const dbPath = join(tempDir, "memory.db");
  const cacheDbPath = join(tempDir, "cache.db");
  const project = basename(workingDirectory);
  const runtimeConfig: VegaConfig = {
    ...config,
    dbPath,
    cacheDbPath,
    dbEncryption: false
  };
  const repository = new Repository(runtimeConfig.dbPath);
  const searchEngine = new SearchEngine(repository, runtimeConfig);
  const memoryService = new MemoryService(repository, runtimeConfig);
  const recallService = new RecallService(repository, searchEngine, runtimeConfig);
  const sessionService = new SessionService(repository, memoryService, recallService, runtimeConfig);
  const archiveService = new ArchiveService(repository, runtimeConfig);

  mkdirSync(workingDirectory, { recursive: true });

  try {
    seedAdapterDataset(repository, archiveService, project);

    const modes = {
      L0: {
        token_estimate: 0,
        latency_ms: 0,
        item_count: 0,
        deep_recall_results: 0
      },
      L1: {
        token_estimate: 0,
        latency_ms: 0,
        item_count: 0,
        deep_recall_results: 0
      },
      L2: {
        token_estimate: 0,
        latency_ms: 0,
        item_count: 0,
        deep_recall_results: 0
      },
      L3: {
        token_estimate: 0,
        latency_ms: 0,
        item_count: 0,
        deep_recall_results: 0
      }
    } satisfies Record<AdapterTokenReportMode, AdapterTokenModeMeasurement>;

    for (const mode of ADAPTER_TOKEN_REPORT_MODES) {
      const startedAt = performance.now();
      const result = await sessionService.sessionStart(
        workingDirectory,
        taskHint,
        undefined,
        mode
      );

      modes[mode] = {
        token_estimate: result.token_estimate,
        latency_ms: round(performance.now() - startedAt),
        item_count: countSessionItems(result),
        deep_recall_results: result.deep_recall?.results.length ?? 0
      };
    }

    return {
      generated_at: new Date().toISOString(),
      task_hint: taskHint,
      token_budget: runtimeConfig.tokenBudget,
      project,
      modes,
      deltas: [
        buildDelta("L0", "L1", modes),
        buildDelta("L1", "L2", modes),
        buildDelta("L2", "L3", modes)
      ],
      savings_vs_l3_pct: buildSavingsVsL3(modes)
    };
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
};

export const buildAdapterTokenReportMarkdown = (report: AdapterTokenReport): string => {
  const lines = [
    "# Vega Memory Adapter Token Report",
    "",
    `Generated: ${report.generated_at}`,
    `Project: ${report.project}`,
    `Task hint: ${report.task_hint}`,
    `Token budget: ${report.token_budget}`,
    "",
    "## Mode Comparison",
    "",
    "| Mode | Token Estimate | Savings vs L3 | Items | Deep Recall Results | Latency (ms) |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  ];

  for (const mode of ADAPTER_TOKEN_REPORT_MODES) {
    const measurement = report.modes[mode];
    const savings = report.savings_vs_l3_pct[mode];

    lines.push(
      `| ${mode} | ${round(measurement.token_estimate)} | ${savings === null ? "n/a" : `${round(savings)}%`} | ${measurement.item_count} | ${measurement.deep_recall_results} | ${round(measurement.latency_ms)} |`
    );
  }

  lines.push("", "## Step-Up Curve", "", "| From | To | Delta Tokens | Delta Ratio |");
  lines.push("| --- | --- | ---: | ---: |");

  for (const delta of report.deltas) {
    lines.push(
      `| ${delta.from} | ${delta.to} | ${round(delta.delta_tokens)} | ${delta.delta_ratio === null ? "n/a" : round(delta.delta_ratio)} |`
    );
  }

  return `${lines.join("\n")}\n`;
};
