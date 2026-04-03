import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Command } from "commander";

import type { VegaConfig } from "../../config.js";
import type { Repository } from "../../db/repository.js";
import { isOllamaAvailable } from "../../embedding/ollama.js";

const getDatabaseSizeBytes = (dbPath: string): number => {
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

const getBackupDirectory = (dbPath: string): string | null => {
  if (dbPath === ":memory:") {
    return null;
  }

  return join(dirname(resolve(dbPath)), "backups");
};

const getLastBackup = (dbPath: string): string | null => {
  const backupDir = getBackupDirectory(dbPath);
  if (!backupDir) {
    return null;
  }

  try {
    const backups = readdirSync(backupDir)
      .filter((entry) => /^memory-\d{4}-\d{2}-\d{2}\.db$/.test(entry))
      .map((entry) => join(backupDir, entry));

    if (backups.length === 0) {
      return null;
    }

    return backups.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  } catch {
    return null;
  }
};

export function registerHealthCommand(
  program: Command,
  repository: Repository,
  config: VegaConfig
): void {
  program
    .command("health")
    .description("Show system health")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      const report = {
        memory_count: repository.listMemories({ limit: 1_000_000 }).length,
        db_size_bytes: getDatabaseSizeBytes(config.dbPath),
        db_size_mb: Number((getDatabaseSizeBytes(config.dbPath) / 1_048_576).toFixed(2)),
        ollama_available: await isOllamaAvailable(config),
        last_backup: getLastBackup(config.dbPath)
      };

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(`memory count: ${report.memory_count}`);
      console.log(`db size: ${report.db_size_mb} MB`);
      console.log(`ollama status: ${report.ollama_available ? "available" : "unavailable"}`);
      console.log(`last backup: ${report.last_backup ?? "none"}`);
    });
}
