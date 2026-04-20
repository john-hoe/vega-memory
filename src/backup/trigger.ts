import {
  Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";

import { createLogger, type Logger } from "../core/logging/index.js";

import { buildManifest, type BackupManifestFile } from "./manifest.js";
import type { BackupConfig } from "./registry.js";

const logger = createLogger({ name: "backup-trigger" });

export const BACKUPS_DIRECTORY_NAME = ".vega/backups";
export const BACKUP_MANIFEST_FILENAME = "manifest.json";
export const BACKUP_TARGET_INDEX_FILENAME = "targets.json";

export interface BackupTargetIndexEntry {
  root_name: string;
  source_path: string;
  kind: "file" | "directory";
}

export interface BackupRuntimeFileSystem {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, data: string | Uint8Array): void;
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  statSync(path: string): Stats;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

export interface CreateBackupResult {
  backup_id: string;
  path: string;
  file_count: number;
  total_bytes: number;
  manifest_sha256: string;
  degraded?: "file_read_error";
}

interface DiscoveredBackupFile {
  source_path: string;
  relative_path: string;
}

const defaultFs: BackupRuntimeFileSystem = {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync: (path, options) => readdirSync(path, options),
  statSync,
  rmSync
};

const normalizePath = (value: string): string => value.replaceAll("\\", "/");
const hashBytes = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const shortHash = (value: string): string => hashBytes(value).slice(0, 8);

const toBackupId = (now: Date, label?: string): string => {
  const base = now.toISOString().replace(/\.\d{3}Z$/u, "Z").replaceAll(":", "-");
  const suffix = label
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);

  return suffix && suffix.length > 0 ? `${base}-${suffix}` : base;
};

const escapeRegExp = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");

const globToRegExp = (pattern: string): RegExp => {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    const next = pattern[index + 1];

    if (current === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (current === "*") {
      source += "[^/]*";
      continue;
    }

    if (current === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(current);
  }

  return new RegExp(`^${source}$`, "u");
};

const matchesExcludeGlob = (path: string, patterns: string[]): boolean => {
  const normalized = normalizePath(path);

  return patterns.some((pattern) => globToRegExp(normalizePath(pattern)).test(normalized));
};

const rootNameForTarget = (
  targetPath: string,
  basenameCounts: Map<string, number>
): string => {
  const targetBase = basename(targetPath);

  if ((basenameCounts.get(targetBase) ?? 0) > 1) {
    return `${shortHash(dirname(targetPath))}-${targetBase}`;
  }

  return targetBase;
};

const listTargetFiles = (
  targetPath: string,
  rootName: string,
  excludeGlobs: string[],
  fs: BackupRuntimeFileSystem
): DiscoveredBackupFile[] => {
  const targetStats = fs.statSync(targetPath);

  if (targetStats.isFile()) {
    return matchesExcludeGlob(rootName, excludeGlobs)
      ? []
      : [
          {
            source_path: targetPath,
            relative_path: rootName
          }
        ];
  }

  if (!targetStats.isDirectory()) {
    return [];
  }

  const discovered: DiscoveredBackupFile[] = [];
  const queue = [targetPath];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name);
      const nestedPath = normalizePath(relative(targetPath, absolutePath));
      const manifestPath = normalizePath(join(rootName, nestedPath));

      if (matchesExcludeGlob(nestedPath, excludeGlobs) || matchesExcludeGlob(manifestPath, excludeGlobs)) {
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      discovered.push({
        source_path: absolutePath,
        relative_path: manifestPath
      });
    }
  }

  return discovered;
};

const buildTargetIndex = (
  targets: string[],
  fs: BackupRuntimeFileSystem
): BackupTargetIndexEntry[] => {
  const basenameCounts = new Map<string, number>();

  for (const targetPath of targets) {
    const targetBase = basename(targetPath);
    basenameCounts.set(targetBase, (basenameCounts.get(targetBase) ?? 0) + 1);
  }

  return targets.flatMap((targetPath) => {
    try {
      const kind = fs.statSync(targetPath).isDirectory() ? "directory" : "file";

      return [
        {
          root_name: rootNameForTarget(targetPath, basenameCounts),
          source_path: targetPath,
          kind
        } satisfies BackupTargetIndexEntry
      ];
    } catch {
      return [];
    }
  });
};

export function applyBackupRetention(options: {
  backupsRoot: string;
  retention: BackupConfig["retention"];
  now?: Date;
  fs?: BackupRuntimeFileSystem;
}): { pruned_count: number } {
  const fs = options.fs ?? defaultFs;

  if (!fs.existsSync(options.backupsRoot)) {
    return {
      pruned_count: 0
    };
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const minAgeMs = options.retention.min_days * 24 * 60 * 60 * 1000;
  const directories = fs
    .readdirSync(options.backupsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(options.backupsRoot, entry.name),
      mtimeMs: fs.statSync(join(options.backupsRoot, entry.name)).mtimeMs
    }))
    .sort((left, right) => right.name.localeCompare(left.name));

  let prunedCount = 0;

  for (const entry of directories.slice(options.retention.max_count)) {
    if (nowMs - entry.mtimeMs < minAgeMs) {
      continue;
    }

    fs.rmSync(entry.path, {
      recursive: true,
      force: true
    });
    prunedCount += 1;
  }

  return {
    pruned_count: prunedCount
  };
}

export async function createBackup(options: {
  config: BackupConfig;
  homeDir: string;
  now?: Date;
  label?: string;
  fs?: BackupRuntimeFileSystem;
  logger?: Logger;
}): Promise<CreateBackupResult> {
  const fs = options.fs ?? defaultFs;
  const activeLogger = options.logger ?? logger;
  const now = options.now ?? new Date();
  const backup_id = toBackupId(now, options.label);
  const path = join(options.homeDir, BACKUPS_DIRECTORY_NAME, backup_id);
  const emptyManifest = buildManifest({
    files: [],
    backup_id,
    now
  });

  if (options.config.targets.length === 0) {
    return {
      backup_id,
      path,
      file_count: 0,
      total_bytes: 0,
      manifest_sha256: emptyManifest.manifest_sha256
    };
  }

  let degraded: CreateBackupResult["degraded"];
  let totalBytes = 0;
  const manifestFiles: BackupManifestFile[] = [];
  const targetIndex = buildTargetIndex(options.config.targets, fs);

  if (targetIndex.length !== options.config.targets.length) {
    degraded = "file_read_error";
    activeLogger.warn("Backup target discovery skipped one or more missing targets.", {
      requested_targets: options.config.targets.length,
      discovered_targets: targetIndex.length
    });
  }

  try {
    fs.mkdirSync(path, { recursive: true });

    for (const target of targetIndex) {
      const discoveredFiles = listTargetFiles(
        target.source_path,
        target.root_name,
        options.config.exclude_globs,
        fs
      );

      for (const file of discoveredFiles) {
        try {
          const bytes = fs.readFileSync(file.source_path);
          const destinationPath = join(path, file.relative_path);
          fs.mkdirSync(dirname(destinationPath), { recursive: true });
          fs.writeFileSync(destinationPath, bytes);
          manifestFiles.push({
            relative_path: file.relative_path,
            size: bytes.byteLength,
            sha256: hashBytes(bytes)
          });
          totalBytes += bytes.byteLength;
        } catch (error) {
          degraded = "file_read_error";
          activeLogger.warn("Backup file copy failed.", {
            path: file.source_path,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    const manifest = buildManifest({
      files: manifestFiles,
      backup_id,
      now
    });

    fs.writeFileSync(join(path, BACKUP_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      join(path, BACKUP_TARGET_INDEX_FILENAME),
      JSON.stringify(
        {
          entries: targetIndex.sort((left, right) => left.root_name.localeCompare(right.root_name))
        },
        null,
        2
      )
    );
    applyBackupRetention({
      backupsRoot: join(options.homeDir, BACKUPS_DIRECTORY_NAME),
      retention: options.config.retention,
      now,
      fs
    });

    return {
      backup_id,
      path,
      file_count: manifest.files.length,
      total_bytes: totalBytes,
      manifest_sha256: manifest.manifest_sha256,
      ...(degraded === undefined ? {} : { degraded })
    };
  } catch (error) {
    activeLogger.warn("Backup creation failed.", {
      backup_id,
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      backup_id,
      path,
      file_count: manifestFiles.length,
      total_bytes: totalBytes,
      manifest_sha256: buildManifest({
        files: manifestFiles,
        backup_id,
        now
      }).manifest_sha256,
      degraded: "file_read_error"
    };
  }
}
