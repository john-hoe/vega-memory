import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

function listBackupPaths(backupDir: string): string[] {
  try {
    return readdirSync(backupDir)
      .filter((entry) => /^memory-\d{4}-\d{2}-\d{2}\.db$/.test(entry))
      .map((entry) => join(backupDir, entry));
  } catch {
    return [];
  }
}

function getLatestBackupPath(backupDir: string): string | null {
  const backups = listBackupPaths(backupDir);
  if (backups.length === 0) {
    return null;
  }

  return backups.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

export function createBackup(dbPath: string, backupDir: string): void {
  mkdirSync(backupDir, { recursive: true });
  const backupName = `memory-${new Date().toISOString().slice(0, 10)}.db`;
  copyFileSync(dbPath, join(backupDir, backupName));
}

export function restoreFromBackup(backupDir: string, dbPath: string): void {
  const latestBackupPath = getLatestBackupPath(backupDir);
  if (!latestBackupPath) {
    throw new Error("No backups available");
  }

  copyFileSync(latestBackupPath, dbPath);
}

export function cleanOldBackups(backupDir: string, retentionDays: number): void {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  for (const backupPath of listBackupPaths(backupDir)) {
    if (statSync(backupPath).mtimeMs < cutoffMs) {
      rmSync(backupPath, { force: true });
    }
  }
}

export function shouldBackup(backupDir: string): boolean {
  const latestBackupPath = getLatestBackupPath(backupDir);
  if (!latestBackupPath) {
    return true;
  }

  const ageMs = Date.now() - statSync(latestBackupPath).mtimeMs;
  return ageMs > 24 * 60 * 60 * 1000;
}
