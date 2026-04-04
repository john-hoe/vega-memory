import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { isOllamaAvailable } from "../embedding/ollama.js";
import {
  getBackupDir,
  getConfigSummary,
  getDatabaseSizeBytes,
  getDiskIssues,
  getLatestBackup
} from "./health.js";
import type {
  DiagnoseReport,
  MemoryStatus,
  MemoryType,
  PerformanceLog,
  VerifiedStatus
} from "./types.js";

interface IntegrityCheckRow {
  integrity_check: string;
}

interface CountRow<TName extends string> {
  name: TName;
  count: number;
}

interface TopRelatedMemoryRow {
  id: string;
  title: string;
  project: string;
  status: MemoryStatus;
  verified: VerifiedStatus;
  access_count: number;
  updated_at: string;
}

interface AverageLatencyRow {
  average_latency: number | null;
}

const formatDate = (value: Date): string => value.toISOString().slice(0, 10);

const formatTime = (value: Date): string => value.toISOString().slice(11, 16).replace(":", "");

const formatPercent = (count: number, total: number): string =>
  total === 0 ? "0.0" : ((count / total) * 100).toFixed(1);

const formatMb = (bytes: number): string => (bytes / 1_048_576).toFixed(2);

const getDiagnosticsPath = (config: VegaConfig, now: Date): string =>
  join(
    dirname(getBackupDir(config)),
    "diagnostics",
    `diagnose-${formatDate(now)}-${formatTime(now)}.md`
  );

const tokenizeIssue = (issue: string): string[] =>
  [...new Set(issue.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter((token) => token.length > 2)
    .slice(0, 8);

const formatCountTable = <TName extends string>(title: string, rows: CountRow<TName>[]): string => {
  const lines = [
    `## ${title}`,
    "",
    "| Name | Count |",
    "| --- | ---: |"
  ];

  if (rows.length === 0) {
    lines.push("| none | 0 |");
  }

  for (const row of rows) {
    lines.push(`| ${row.name} | ${row.count} |`);
  }

  lines.push("");
  return lines.join("\n");
};

const formatPerformanceTable = (rows: PerformanceLog[]): string => {
  const lines = [
    "## Recent Performance",
    "",
    "| Timestamp | Operation | Latency (ms) | Memory Count | Result Count |",
    "| --- | --- | ---: | ---: | ---: |"
  ];

  if (rows.length === 0) {
    lines.push("| none | none | 0.00 | 0 | 0 |");
  }

  for (const row of rows) {
    lines.push(
      `| ${row.timestamp} | ${row.operation} | ${row.latency_ms.toFixed(2)} | ${row.memory_count} | ${row.result_count} |`
    );
  }

  lines.push("");
  return lines.join("\n");
};

const formatRelatedMemoriesTable = (rows: TopRelatedMemoryRow[]): string => {
  const lines = [
    "## Related Memories",
    "",
    "| ID | Title | Project | Status | Verified | Access Count | Updated At |",
    "| --- | --- | --- | --- | --- | ---: | --- |"
  ];

  if (rows.length === 0) {
    lines.push("| none | none | none | none | none | 0 | n/a |");
  }

  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${row.title} | ${row.project} | ${row.status} | ${row.verified} | ${row.access_count} | ${row.updated_at} |`
    );
  }

  lines.push("");
  return lines.join("\n");
};

const formatBulletSection = (title: string, values: string[]): string => {
  const lines = [`## ${title}`, ""];

  if (values.length === 0) {
    lines.push("- none");
  } else {
    for (const value of values) {
      lines.push(`- ${value}`);
    }
  }

  lines.push("");
  return lines.join("\n");
};

const formatSystemInfoSection = (
  config: VegaConfig,
  dbSizeBytes: number,
  backupPath: string | null
): string =>
  [
    "## System Info",
    "",
    `- Node version: ${process.version}`,
    `- OS: ${process.platform} ${process.arch}`,
    `- DB path: ${config.dbPath}`,
    `- Database size: ${dbSizeBytes} bytes (${formatMb(dbSizeBytes)} MB)`,
    `- Latest backup: ${backupPath ?? "none"}`,
    "",
    "### Config Summary",
    "",
    ...getConfigSummary(config).map((entry) => `- ${entry}`),
    ""
  ].join("\n");

const buildHandoffPrompt = (options: {
  generatedAt: string;
  issue: string | undefined;
  summary: string;
  issuesFound: string[];
  suggestedFixes: string[];
  totalMemories: number;
  nullEmbeddings: number;
  integrityResult: string;
  ollamaAvailable: boolean;
  backupPath: string | null;
  averageLatency: number;
  performanceEntries: PerformanceLog[];
  diskIssues: string[];
  config: VegaConfig;
}): string => {
  const recentPerformance =
    options.performanceEntries.length === 0
      ? "- none"
      : options.performanceEntries
          .slice(0, 10)
          .map(
            (entry) =>
              `- ${entry.timestamp} | ${entry.operation} | ${entry.latency_ms.toFixed(2)} ms | memories=${entry.memory_count} | results=${entry.result_count}`
          )
          .join("\n");

  return [
    "# Vega Memory Debug Handoff",
    "",
    "## Issue Description",
    "",
    `- Reported issue: ${options.issue ?? "No specific issue provided"}`,
    `- Diagnose summary: ${options.summary}`,
    "",
    "## System State",
    "",
    `- Generated at: ${options.generatedAt}`,
    `- Node version: ${process.version}`,
    `- OS: ${process.platform} ${process.arch}`,
    `- DB path: ${options.config.dbPath}`,
    `- Config summary: ${getConfigSummary(options.config).join(", ")}`,
    `- Database integrity: ${options.integrityResult}`,
    `- Ollama available: ${options.ollamaAvailable ? "yes" : "no"}`,
    `- Total memories: ${options.totalMemories}`,
    `- Null embeddings: ${options.nullEmbeddings}`,
    `- Latest backup: ${options.backupPath ?? "none"}`,
    `- Average latency: ${options.averageLatency.toFixed(2)} ms`,
    options.diskIssues.length > 0 ? `- Disk issues: ${options.diskIssues.join("; ")}` : "- Disk issues: none",
    "",
    "## Recent Performance",
    "",
    recentPerformance,
    "",
    "## Suggested Next Steps",
    "",
    ...options.suggestedFixes.map((fix, index) => `${index + 1}. ${fix}`),
    ...(options.suggestedFixes.length === 0
      ? ["1. Review the diagnose report and reproduce the issue with more targeted logs."]
      : []),
    "",
    "## Issues Found",
    "",
    ...(options.issuesFound.length > 0
      ? options.issuesFound.map((issue) => `- ${issue}`)
      : ["- none"])
  ].join("\n");
};

export class DiagnoseService {
  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {}

  private findRelatedMemories(issue: string): TopRelatedMemoryRow[] {
    const tokens = tokenizeIssue(issue);

    if (tokens.length === 0) {
      return [];
    }

    const clauses = tokens.map(() => "(lower(title) LIKE ? OR lower(content) LIKE ? OR lower(tags) LIKE ?)");
    const params = tokens.flatMap((token) => {
      const pattern = `%${token}%`;
      return [pattern, pattern, pattern];
    });

    return this.repository.db
      .prepare<unknown[], TopRelatedMemoryRow>(
        `SELECT id, title, project, status, verified, access_count, updated_at
         FROM memories
         WHERE ${clauses.join(" OR ")}
         ORDER BY access_count DESC, updated_at DESC
         LIMIT 10`
      )
      .all(...params);
  }

  async diagnose(issue?: string): Promise<DiagnoseReport> {
    const now = new Date();
    const integrityRows = this.repository.db
      .prepare<[], IntegrityCheckRow>("PRAGMA integrity_check")
      .all();
    const integrityResult = integrityRows.map((row) => row.integrity_check).join(", ");
    const ollamaAvailable = await isOllamaAvailable(this.config);
    const totalMemories =
      this.repository.db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM memories").get()
        ?.count ?? 0;
    const nullEmbeddings =
      this.repository.db
        .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM memories WHERE embedding IS NULL")
        .get()?.count ?? 0;
    const statusCounts = this.repository.db
      .prepare<[], CountRow<MemoryStatus>>(
        `SELECT status AS name, COUNT(*) AS count
         FROM memories
         GROUP BY status
         ORDER BY count DESC, name ASC`
      )
      .all();
    const typeCounts = this.repository.db
      .prepare<[], CountRow<MemoryType>>(
        `SELECT type AS name, COUNT(*) AS count
         FROM memories
         GROUP BY type
         ORDER BY count DESC, name ASC`
      )
      .all();
    const dbSizeBytes = getDatabaseSizeBytes(this.config.dbPath);
    const backupInfo = getLatestBackup(this.config);
    const diskIssues = getDiskIssues(this.config);
    const performanceEntries = this.repository.db
      .prepare<[], PerformanceLog>(
        `SELECT timestamp, operation, latency_ms, memory_count, result_count
         FROM performance_log
         ORDER BY timestamp DESC
         LIMIT 50`
      )
      .all();
    const averageLatency =
      this.repository.db
        .prepare<[], AverageLatencyRow>("SELECT AVG(latency_ms) AS average_latency FROM performance_log")
        .get()?.average_latency ?? 0;
    const relatedMemories = issue ? this.findRelatedMemories(issue) : [];
    const issuesFound: string[] = [];
    const autoFixableIssues: string[] = [];

    if (integrityResult !== "ok") {
      issuesFound.push(`Database integrity check returned: ${integrityResult}`);
    }
    if (diskIssues.length > 0) {
      issuesFound.push(...diskIssues);
    }
    if (!ollamaAvailable) {
      issuesFound.push(`Ollama is unavailable at ${this.config.ollamaBaseUrl}`);
    }
    if (nullEmbeddings > 0) {
      const message = `${nullEmbeddings} memories have null embeddings`;
      issuesFound.push(message);
      autoFixableIssues.push(message);
    }
    if (this.config.dbPath !== ":memory:" && backupInfo === null) {
      issuesFound.push("No backups found");
      autoFixableIssues.push("No backups found");
    } else if (backupInfo !== null && backupInfo.age_days > 1.5) {
      const message = `Latest backup is ${backupInfo.age_days.toFixed(1)} days old`;
      issuesFound.push(message);
      autoFixableIssues.push(message);
    }
    if (performanceEntries.length === 0) {
      issuesFound.push("No performance log entries found");
    } else if (averageLatency > 250) {
      issuesFound.push(`Average performance latency is elevated at ${averageLatency.toFixed(2)} ms`);
    }
    if (issue && relatedMemories.length === 0) {
      issuesFound.push(`No stored memories matched the issue description: ${issue}`);
    }

    const suggestedFixes: string[] = [];

    if (integrityResult !== "ok") {
      suggestedFixes.push("Restore the database from the latest healthy backup and rerun integrity_check.");
    }
    if (diskIssues.length > 0) {
      suggestedFixes.push(
        "Verify database path permissions and free disk space before retrying maintenance or write operations."
      );
    }
    if (!ollamaAvailable) {
      suggestedFixes.push(
        `Start Ollama and verify that ${this.config.ollamaBaseUrl} responds before running embedding-dependent operations.`
      );
    }
    if (nullEmbeddings > 0) {
      suggestedFixes.push(
        "Run daily maintenance or resave affected memories so missing embeddings are rebuilt."
      );
    }
    if (backupInfo === null || backupInfo.age_days > 1.5) {
      suggestedFixes.push("Run daily maintenance to create a fresh backup under data/backups.");
    }
    if (performanceEntries.length === 0) {
      suggestedFixes.push("Exercise the CLI or MCP tools to populate performance_log before comparing latency trends.");
    } else if (averageLatency > 250) {
      suggestedFixes.push("Run `vega benchmark --suite recall` and inspect the recent performance_log latency spikes.");
    }
    if (issue && relatedMemories.length === 0) {
      suggestedFixes.push("Store more explicit memories about the reported issue to improve future diagnosis.");
    }
    if (suggestedFixes.length === 0) {
      suggestedFixes.push("No immediate fixes suggested.");
    }

    const summary =
      issuesFound.length === 0
        ? `Diagnose completed with no issues across ${totalMemories} memories.`
        : `Diagnose completed with ${issuesFound.length} issue(s) across ${totalMemories} memories.`;
    const reportPath = getDiagnosticsPath(this.config, now);
    const handoffPrompt = buildHandoffPrompt({
      generatedAt: now.toISOString(),
      issue,
      summary,
      issuesFound,
      suggestedFixes,
      totalMemories,
      nullEmbeddings,
      integrityResult,
      ollamaAvailable,
      backupPath: backupInfo?.path ?? null,
      averageLatency,
      performanceEntries,
      diskIssues,
      config: this.config
    });
    const canAutoFix =
      issuesFound.length === 0 ||
      (integrityResult === "ok" &&
        diskIssues.length === 0 &&
        issuesFound.length === autoFixableIssues.length);
    const content = [
      "# Memory Diagnose Report",
      "",
      `Generated: ${now.toISOString()}`,
      issue ? `Issue: ${issue}` : "Issue: none",
      "",
      "## Summary",
      "",
      `- ${summary}`,
      `- Ollama available: ${ollamaAvailable ? "yes" : "no"}`,
      `- Can auto fix: ${canAutoFix ? "yes" : "no"}`,
      `- Latest backup: ${backupInfo?.path ?? "none"}`,
      `- Backup age: ${backupInfo ? `${backupInfo.age_days.toFixed(1)} days` : "n/a"}`,
      `- Null embeddings: ${nullEmbeddings}`,
      `- Average latency: ${averageLatency.toFixed(2)} ms`,
      "",
      formatSystemInfoSection(this.config, dbSizeBytes, backupInfo?.path ?? null),
      "## Memory Quality",
      "",
      `- Total memories: ${totalMemories}`,
      `- Null embeddings: ${formatPercent(nullEmbeddings, totalMemories)}% (${nullEmbeddings}/${totalMemories})`,
      "",
      formatCountTable("Memories by Status", statusCounts),
      formatCountTable("Memories by Type", typeCounts),
      formatPerformanceTable(performanceEntries),
      issue ? formatRelatedMemoriesTable(relatedMemories) : "",
      formatBulletSection("Issues Found", issuesFound),
      formatBulletSection("Suggested Fixes", suggestedFixes),
      "## Handoff Prompt",
      "",
      "```md",
      handoffPrompt,
      "```",
      ""
    ]
      .filter(Boolean)
      .join("\n");

    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, content, "utf8");

    return {
      report_path: reportPath,
      summary,
      suggested_fixes: suggestedFixes,
      issues_found: issuesFound,
      handoff_prompt: handoffPrompt,
      can_auto_fix: canAutoFix
    };
  }
}
