import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3-multiple-ciphers";

import { decryptBuffer, encryptBuffer } from "../security/encryption.js";

type BackupOptions = Parameters<InstanceType<typeof BetterSqlite3>["backup"]>[1];
const ENCRYPTED_BACKUP_SUFFIX = ".enc";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

function isPlainSqliteDatabase(dbPath: string): boolean {
  try {
    const header = readFileSync(dbPath).subarray(0, SQLITE_HEADER.length);
    return header.equals(SQLITE_HEADER);
  } catch {
    return false;
  }
}

function listBackupPaths(backupDir: string): string[] {
  try {
    return readdirSync(backupDir)
      .filter((entry) => /^memory-\d{4}-\d{2}-\d{2}\.db(?:\.enc)?$/.test(entry))
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

export async function createBackup(
  dbPath: string,
  backupDir: string,
  options?: BackupOptions,
  encryptionKey?: string
): Promise<string> {
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `memory-${new Date().toISOString().slice(0, 10)}.db`);
  const plainSqliteDatabase = isPlainSqliteDatabase(dbPath);
  const sourceDb = new BetterSqlite3(dbPath, { fileMustExist: true });

  try {
    if (!plainSqliteDatabase && encryptionKey) {
      sourceDb.pragma(`key = "x'${encryptionKey}'"`);
    }

    sourceDb.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    sourceDb.close();
  }

  copyFileSync(dbPath, backupPath);

  if (encryptionKey === undefined || !plainSqliteDatabase) {
    return backupPath;
  }

  const encryptedPath = `${backupPath}${ENCRYPTED_BACKUP_SUFFIX}`;
  writeFileSync(encryptedPath, encryptBuffer(readFileSync(backupPath), encryptionKey));
  rmSync(backupPath, { force: true });

  return encryptedPath;
}

export function restoreFromBackup(
  backupDir: string,
  dbPath: string,
  encryptionKey?: string
): void {
  const latestBackupPath = getLatestBackupPath(backupDir);
  if (!latestBackupPath) {
    throw new Error("No backups available");
  }

  if (!latestBackupPath.endsWith(ENCRYPTED_BACKUP_SUFFIX)) {
    copyFileSync(latestBackupPath, dbPath);
    return;
  }

  if (encryptionKey === undefined) {
    throw new Error("Encrypted backup requires VEGA_ENCRYPTION_KEY");
  }

  writeFileSync(dbPath, decryptBuffer(readFileSync(latestBackupPath), encryptionKey));
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
