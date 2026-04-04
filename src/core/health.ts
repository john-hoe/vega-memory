import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { isOllamaAvailable } from "../embedding/ollama.js";
import type { HealthReport } from "./types.js";

interface IntegrityCheckRow {
  integrity_check: string;
}

interface AverageLatencyRow {
  average_latency: number | null;
}

export interface BackupInfo {
  path: string;
  timestamp: string;
  age_days: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const getDataDir = (config: VegaConfig): string =>
  config.dbPath === ":memory:" ? resolve(process.cwd(), "data") : dirname(resolve(config.dbPath));

export const getBackupDir = (config: VegaConfig): string =>
  join(getDataDir(config), "backups");

export const getDatabaseSizeBytes = (dbPath: string): number => {
  if (dbPath === ":memory:") {
    return 0;
  }

  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((total, path) => {
    if (!existsSync(path)) {
      return total;
    }

    return total + statSync(path).size;
  }, 0);
};

export const getLatestBackup = (config: VegaConfig): BackupInfo | null => {
  if (config.dbPath === ":memory:") {
    return null;
  }

  try {
    const latest = readdirSync(getBackupDir(config))
      .filter((entry) => /^memory-\d{4}-\d{2}-\d{2}\.db(?:\.enc)?$/.test(entry))
      .map((entry) => join(getBackupDir(config), entry))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];

    if (!latest) {
      return null;
    }

    const modifiedAt = statSync(latest).mtimeMs;

    return {
      path: latest,
      timestamp: new Date(modifiedAt).toISOString(),
      age_days: (Date.now() - modifiedAt) / DAY_MS
    };
  } catch {
    return null;
  }
};

export const getDiskIssues = (config: VegaConfig): string[] => {
  if (config.dbPath === ":memory:") {
    return [];
  }

  const issues: string[] = [];
  const resolvedDbPath = resolve(config.dbPath);

  if (!existsSync(resolvedDbPath)) {
    issues.push(`Database file is missing: ${resolvedDbPath}`);
    return issues;
  }

  try {
    accessSync(resolvedDbPath, constants.R_OK | constants.W_OK);
  } catch {
    issues.push(`Database file is not readable and writable: ${resolvedDbPath}`);
  }

  try {
    accessSync(dirname(resolvedDbPath), constants.R_OK | constants.W_OK);
  } catch {
    issues.push(`Database directory is not readable and writable: ${dirname(resolvedDbPath)}`);
  }

  return issues;
};

export const getConfigSummary = (config: VegaConfig): string[] => [
  `mode=${config.mode}`,
  `ollama_base_url=${config.ollamaBaseUrl}`,
  `ollama_model=${config.ollamaModel}`,
  `token_budget=${config.tokenBudget}`,
  `similarity_threshold=${config.similarityThreshold}`,
  `backup_retention_days=${config.backupRetentionDays}`,
  `api_port=${config.apiPort}`,
  `api_key_configured=${config.apiKey !== undefined}`,
  `cloud_backup=${config.cloudBackup?.enabled === true ? config.cloudBackup.provider : "disabled"}`,
  `telegram_configured=${config.telegramBotToken !== undefined && config.telegramChatId !== undefined}`
];

export async function getHealthReport(
  repository: Repository,
  config: VegaConfig
): Promise<HealthReport> {
  const integrityRows = repository.db
    .prepare<[], IntegrityCheckRow>("PRAGMA integrity_check")
    .all();
  const integrityResult = integrityRows.map((row) => row.integrity_check).join(", ");
  const db_integrity = integrityResult === "ok";
  const ollama = await isOllamaAvailable(config);
  const memories =
    repository.db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM memories").get()
      ?.count ?? 0;
  const latency_avg_ms =
    repository.db
      .prepare<[], AverageLatencyRow>(
        `SELECT AVG(latency_ms) AS average_latency
         FROM (
           SELECT latency_ms
           FROM performance_log
           ORDER BY timestamp DESC
           LIMIT 100
         )`
      )
      .get()?.average_latency ?? 0;
  const db_size_mb = Number((getDatabaseSizeBytes(config.dbPath) / 1_048_576).toFixed(2));
  const latestBackup = getLatestBackup(config);
  const diskIssues = getDiskIssues(config);
  const issues: string[] = [];
  const fixSuggestions: string[] = [];

  if (!db_integrity) {
    issues.push(`Database integrity check returned: ${integrityResult}`);
    fixSuggestions.push("Restore the database from the latest healthy backup and rerun integrity_check.");
  }
  if (diskIssues.length > 0) {
    issues.push(...diskIssues);
    fixSuggestions.push(
      "Verify filesystem permissions and available disk space for the database directory before retrying."
    );
  }
  if (!ollama) {
    issues.push(`Ollama is unavailable at ${config.ollamaBaseUrl}`);
    fixSuggestions.push(
      `Start Ollama and verify that ${config.ollamaBaseUrl} responds before running embedding-dependent operations.`
    );
  }
  if (config.dbPath !== ":memory:" && latestBackup === null) {
    issues.push("No backups found");
    fixSuggestions.push("Run daily maintenance or `vega backup` to create a fresh local backup.");
  } else if (latestBackup !== null && latestBackup.age_days > 1.5) {
    issues.push(`Latest backup is ${latestBackup.age_days.toFixed(1)} days old`);
    fixSuggestions.push("Run daily maintenance or `vega backup` to refresh the local backup.");
  }
  if (latency_avg_ms > 300) {
    issues.push(`Average latency over the last 100 operations is ${latency_avg_ms.toFixed(2)} ms`);
    fixSuggestions.push(
      "Run `vega benchmark --suite recall` and verify sqlite-vec indexing if recall latency stays elevated."
    );
  }

  let status: HealthReport["status"] = "healthy";

  if (!db_integrity || diskIssues.length > 0) {
    status = "unhealthy";
  } else if (issues.length > 0) {
    status = "degraded";
  }

  return {
    status,
    ollama,
    db_integrity,
    memories,
    latency_avg_ms: Number(latency_avg_ms.toFixed(2)),
    db_size_mb,
    last_backup: latestBackup?.timestamp ?? null,
    issues,
    fix_suggestions: [...new Set(fixSuggestions)]
  };
}
