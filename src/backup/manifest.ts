import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const hashBytes = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const toBuffer = (value: Uint8Array | string): Uint8Array =>
  typeof value === "string" ? Buffer.from(value) : value;

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
): { ok: boolean; mismatches: string[] } {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path));
  const mismatches: string[] = [];
  const manifestHash = hashBytes(JSON.stringify(manifest.files));

  if (manifestHash !== manifest.manifest_sha256) {
    mismatches.push("manifest_sha256");
  }

  for (const file of manifest.files) {
    try {
      const bytes = toBuffer(readFile(join(options.expectedBasePath, file.relative_path)));
      if (bytes.byteLength !== file.size || hashBytes(bytes) !== file.sha256) {
        mismatches.push(file.relative_path);
      }
    } catch {
      mismatches.push(file.relative_path);
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches
  };
}
