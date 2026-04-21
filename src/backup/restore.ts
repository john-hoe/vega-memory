import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { z } from "zod";

import { createLogger, type Logger } from "../core/logging/index.js";

import {
  BackupIntegrityError,
  type BackupIntegrityFailure,
  BackupManifestSchema,
  assertSafeRelativePath,
  verifyManifest
} from "./manifest.js";
import { DEFAULT_BACKUP_CONFIG_PATH, loadBackupConfig } from "./registry.js";
import {
  BACKUP_MANIFEST_FILENAME,
  BACKUP_TARGET_INDEX_FILENAME,
  BACKUPS_DIRECTORY_NAME,
  type BackupRuntimeFileSystem,
  type BackupTargetIndexEntry
} from "./trigger.js";

const logger = createLogger({ name: "backup-restore" });

const TargetIndexFileSchema = z.object({
  entries: z.array(
    z.object({
      root_name: z.string().trim().min(1),
      source_path: z.string().trim().min(1),
      kind: z.enum(["file", "directory"])
    })
  )
});

const defaultFs: BackupRuntimeFileSystem = {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync() {
    return [];
  },
  statSync,
  rmSync() {}
};

const hashBytes = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const normalizePath = (value: string): string => value.replaceAll("\\", "/");

interface RestoreStateFile {
  relative_path: string;
  state: string | null;
}

interface InternalRestoreResult {
  restored_at: string;
  files_restored: number;
  verified: boolean;
  mismatches: string[];
  degraded?: "backup_missing" | "manifest_parse_error" | "file_read_error";
  before_state_sha256?: string | null;
  after_state_sha256?: string | null;
  error?: BackupIntegrityFailure;
}

const computeStateHash = (
  destinations: Array<{ relative_path: string; destination_path: string }>,
  fs: BackupRuntimeFileSystem
): string =>
  hashBytes(
    JSON.stringify(
      destinations
        .map<RestoreStateFile>((entry) => {
          try {
            if (!fs.existsSync(entry.destination_path)) {
              return {
                relative_path: entry.relative_path,
                state: null
              };
            }

            return {
              relative_path: entry.relative_path,
              state: hashBytes(fs.readFileSync(entry.destination_path))
            };
          } catch {
            return {
              relative_path: entry.relative_path,
              state: null
            };
          }
        })
        .sort((left, right) => left.relative_path.localeCompare(right.relative_path))
    )
  );

const loadTargetIndex = (
  backupPath: string,
  homeDir: string,
  fs: BackupRuntimeFileSystem
): BackupTargetIndexEntry[] => {
  const indexPath = join(backupPath, BACKUP_TARGET_INDEX_FILENAME);

  if (fs.existsSync(indexPath)) {
    return TargetIndexFileSchema.parse(JSON.parse(readFileSync(indexPath, "utf8"))).entries;
  }

  return loadBackupConfig(DEFAULT_BACKUP_CONFIG_PATH, {
    env: {
      ...process.env,
      HOME: homeDir
    }
  }).targets.map((target) => ({
    root_name: target.split(/[\\/]/u).at(-1) ?? target,
    source_path: target,
    kind: "file" as const
  }));
};

const resolveDestinationPath = (
  relativePath: string,
  backupPath: string,
  indexByRoot: Map<string, BackupTargetIndexEntry>
): string | null => {
  const normalized = normalizePath(assertSafeRelativePath(relativePath, backupPath));
  const [rootName, ...rest] = normalized.split("/");
  const target = indexByRoot.get(rootName);

  if (target === undefined) {
    return null;
  }

  if (target.kind === "file") {
    return rest.length === 0 ? target.source_path : null;
  }

  const destinationRelativePath = assertSafeRelativePath(rest.join("/"), target.source_path);
  return join(target.source_path, destinationRelativePath);
};

const truncatePathForLog = (value: string): string =>
  value.length <= 200 ? value : `${value.slice(0, 197)}...`;

const rejectedRestoreResult = (
  error: BackupIntegrityFailure,
  backup_id: string,
  manifest_id: string,
  restored_at: string,
  activeLogger: Logger
): InternalRestoreResult => {
  activeLogger.warn("Restore rejected unsafe manifest path.", {
    backup_id,
    manifest_id,
    status: "rejected",
    error_code: error.code,
    relative_path: truncatePathForLog(error.path)
  });

  return {
    restored_at,
    files_restored: 0,
    verified: false,
    mismatches: [error.code],
    error
  };
};

const selectFiles = (
  files: Array<{ relative_path: string }>,
  mode: "full" | "selective",
  selective?: { files: string[] }
): Array<{ relative_path: string }> => {
  if (mode === "full") {
    return files;
  }

  const allowed = new Set((selective?.files ?? []).map((file) => normalizePath(file)));
  return files.filter((file) => allowed.has(normalizePath(file.relative_path)));
};

export async function restoreBackup(options: {
  backup_id: string;
  mode: "full" | "selective";
  selective?: {
    files: string[];
  };
  homeDir: string;
  fs?: BackupRuntimeFileSystem;
  dryRun?: boolean;
  logger?: Logger;
}): Promise<InternalRestoreResult> {
  const fs = options.fs ?? defaultFs;
  const activeLogger = options.logger ?? logger;
  const restored_at = new Date().toISOString();
  const backupPath = join(options.homeDir, BACKUPS_DIRECTORY_NAME, options.backup_id);
  const manifestPath = join(backupPath, BACKUP_MANIFEST_FILENAME);

  try {
    if (!fs.existsSync(manifestPath)) {
      return {
        restored_at,
        files_restored: 0,
        verified: false,
        mismatches: [],
        degraded: "backup_missing"
      };
    }

    const manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    const verification = verifyManifest(manifest, { expectedBasePath: backupPath });

    if (verification.error !== undefined) {
      return rejectedRestoreResult(
        verification.error,
        options.backup_id,
        manifest.backup_id,
        restored_at,
        activeLogger
      );
    }

    if (!verification.ok) {
      return {
        restored_at,
        files_restored: 0,
        verified: false,
        mismatches: verification.mismatches
      };
    }

    const targetIndex = loadTargetIndex(backupPath, options.homeDir, fs);
    const indexByRoot = new Map(targetIndex.map((entry) => [entry.root_name, entry]));
    const filesToRestore = selectFiles(manifest.files, options.mode, options.selective);
    const destinations = filesToRestore.flatMap((file) => {
      const safeRelativePath = assertSafeRelativePath(file.relative_path, backupPath);
      const destinationPath = resolveDestinationPath(safeRelativePath, backupPath, indexByRoot);
      return destinationPath === null
        ? []
        : [
            {
              relative_path: safeRelativePath,
              destination_path: destinationPath
            }
          ];
    });
    const before_state_sha256 = computeStateHash(destinations, fs);

    if (options.dryRun === true) {
      return {
        restored_at,
        files_restored: 0,
        verified: true,
        mismatches: [],
        before_state_sha256,
        after_state_sha256: before_state_sha256
      };
    }

    let files_restored = 0;
    let degraded: InternalRestoreResult["degraded"];

    for (const destination of destinations) {
      try {
        const sourceRelativePath = assertSafeRelativePath(destination.relative_path, backupPath);
        const bytes = fs.readFileSync(join(backupPath, sourceRelativePath));
        fs.mkdirSync(dirname(destination.destination_path), { recursive: true });
        fs.writeFileSync(destination.destination_path, bytes);
        files_restored += 1;
      } catch (error) {
        degraded = "file_read_error";
        activeLogger.warn("Restore file copy failed.", {
          backup_id: options.backup_id,
          relative_path: destination.relative_path,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return {
      restored_at,
      files_restored,
      verified: true,
      mismatches: [],
      before_state_sha256,
      after_state_sha256: computeStateHash(destinations, fs),
      ...(degraded === undefined ? {} : { degraded })
    };
  } catch (error) {
    if (error instanceof BackupIntegrityError) {
      return rejectedRestoreResult(
        {
          code: error.code,
          path: error.path,
          message: error.message
        },
        options.backup_id,
        options.backup_id,
        restored_at,
        activeLogger
      );
    }

    activeLogger.warn("Restore failed.", {
      backup_id: options.backup_id,
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      restored_at,
      files_restored: 0,
      verified: false,
      mismatches: [],
      degraded: "manifest_parse_error"
    };
  }
}

export async function runRestoreDrill(options: {
  backup_id: string;
  homeDir: string;
  fs?: BackupRuntimeFileSystem;
  logger?: Logger;
}): Promise<{
  verified: boolean;
  mismatches: string[];
  degraded?: "backup_missing" | "manifest_parse_error" | "file_read_error";
}> {
  const result = await restoreBackup({
    backup_id: options.backup_id,
    mode: "full",
    dryRun: true,
    homeDir: options.homeDir,
    fs: options.fs,
    logger: options.logger
  });

  return {
    verified: result.verified,
    mismatches: result.mismatches,
    ...(result.degraded === undefined ? {} : { degraded: result.degraded })
  };
}
