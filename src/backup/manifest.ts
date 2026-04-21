import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

import { z } from "zod";

export const BackupManifestFileSchema = z.object({
  relative_path: z.string().trim().min(1),
  size: z.number().int().gte(0),
  sha256: z.string().trim().length(64)
});

export const BackupManifestSchema = z.object({
  schema_version: z.literal("1.0"),
  backup_id: z.string().trim().min(1),
  created_at: z.string().trim().min(1),
  created_by: z.literal("vega-backup"),
  files: z.array(BackupManifestFileSchema),
  manifest_sha256: z.string().trim().length(64)
});

export type BackupManifestFile = z.infer<typeof BackupManifestFileSchema>;
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
export type BackupIntegrityErrorCode =
  | "UNSAFE_ABSOLUTE_PATH"
  | "UNSAFE_TRAVERSAL_SEGMENT"
  | "UNSAFE_NULL_BYTE"
  | "UNSAFE_OUTSIDE_BASE";

export interface BackupIntegrityFailure {
  code: BackupIntegrityErrorCode;
  path: string;
  message: string;
}

export class BackupIntegrityError extends Error implements BackupIntegrityFailure {
  readonly code: BackupIntegrityErrorCode;
  readonly path: string;

  constructor(code: BackupIntegrityErrorCode, unsafePath: string, message: string) {
    super(message);
    this.name = "BackupIntegrityError";
    this.code = code;
    this.path = unsafePath;
  }
}

const hashBytes = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const toBuffer = (value: Uint8Array | string): Uint8Array =>
  typeof value === "string" ? Buffer.from(value) : value;

const withVerificationError = (
  result: { ok: boolean; mismatches: string[] },
  error: BackupIntegrityFailure
): { ok: boolean; mismatches: string[]; error: BackupIntegrityFailure } => {
  Object.defineProperty(result, "error", {
    value: error,
    enumerable: false,
    configurable: true,
    writable: false
  });

  return result as { ok: boolean; mismatches: string[]; error: BackupIntegrityFailure };
};

export function assertSafeRelativePath(relative_path: string, base: string): string {
  const normalized = normalize(relative_path);
  const posixNormalized = normalized.replaceAll("\\", "/");

  if (normalized.includes("\0")) {
    throw new BackupIntegrityError(
      "UNSAFE_NULL_BYTE",
      relative_path,
      `Unsafe backup path "${relative_path}" contains null bytes.`
    );
  }

  if (isAbsolute(normalized)) {
    throw new BackupIntegrityError(
      "UNSAFE_ABSOLUTE_PATH",
      relative_path,
      `Unsafe backup path "${relative_path}" must be relative.`
    );
  }

  if (posixNormalized === ".." || posixNormalized.startsWith("../") || posixNormalized.includes("/../")) {
    throw new BackupIntegrityError(
      "UNSAFE_TRAVERSAL_SEGMENT",
      relative_path,
      `Unsafe backup path "${relative_path}" contains traversal segments after normalization.`
    );
  }

  const resolvedBase = resolve(base);
  const resolved = resolve(resolvedBase, normalized);

  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + sep)) {
    throw new BackupIntegrityError(
      "UNSAFE_OUTSIDE_BASE",
      relative_path,
      `Unsafe backup path "${relative_path}" resolves outside "${resolvedBase}".`
    );
  }

  return normalized;
}

export function buildManifest(options: {
  files: BackupManifestFile[];
  backup_id: string;
  now?: Date;
}): BackupManifest {
  const files = [...options.files].sort((left, right) => left.relative_path.localeCompare(right.relative_path));

  return {
    schema_version: "1.0",
    backup_id: options.backup_id,
    created_at: (options.now ?? new Date()).toISOString(),
    created_by: "vega-backup",
    files,
    manifest_sha256: hashBytes(JSON.stringify(files))
  };
}

export function verifyManifest(
  manifest: BackupManifest,
  options: {
    readFile?: (path: string) => Uint8Array | string;
    expectedBasePath: string;
  }
): { ok: boolean; mismatches: string[]; error?: BackupIntegrityFailure } {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path));
  const mismatches: string[] = [];
  const manifestHash = hashBytes(JSON.stringify(manifest.files));

  if (manifestHash !== manifest.manifest_sha256) {
    mismatches.push("manifest_sha256");
  }

  for (const file of manifest.files) {
    try {
      const safeRelativePath = assertSafeRelativePath(file.relative_path, options.expectedBasePath);
      const bytes = toBuffer(readFile(join(options.expectedBasePath, safeRelativePath)));
      if (bytes.byteLength !== file.size || hashBytes(bytes) !== file.sha256) {
        mismatches.push(file.relative_path);
      }
    } catch (error) {
      if (error instanceof BackupIntegrityError) {
        return withVerificationError(
          {
            ok: false,
            mismatches: [...mismatches, error.code]
          },
          {
            code: error.code,
            path: error.path,
            message: error.message
          }
        );
      }

      mismatches.push(file.relative_path);
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches
  };
}
