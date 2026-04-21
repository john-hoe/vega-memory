import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  applyRestoreAuditMigration,
  listRestoreAudit,
  recordRestoreAudit
} from "../backup/audit.js";
import { buildManifest, verifyManifest } from "../backup/manifest.js";
import { restoreBackup } from "../backup/restore.js";
import {
  BACKUP_MANIFEST_FILENAME,
  BACKUP_TARGET_INDEX_FILENAME,
  BACKUPS_DIRECTORY_NAME
} from "../backup/trigger.js";
import { createLogger, type LogRecord } from "../core/logging/index.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const writeFile = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
};

const writeBackupFixture = (options: {
  homeDir: string;
  backup_id: string;
  manifest: ReturnType<typeof buildManifest>;
  targets?: Array<{ root_name: string; source_path: string; kind: "file" | "directory" }>;
}): string => {
  const backupPath = join(options.homeDir, BACKUPS_DIRECTORY_NAME, options.backup_id);
  mkdirSync(backupPath, { recursive: true });
  writeFileSync(join(backupPath, BACKUP_MANIFEST_FILENAME), JSON.stringify(options.manifest, null, 2), "utf8");

  if (options.targets !== undefined) {
    writeFileSync(
      join(backupPath, BACKUP_TARGET_INDEX_FILENAME),
      JSON.stringify({ entries: options.targets }, null, 2),
      "utf8"
    );
  }

  return backupPath;
};

test("restoreBackup rejects ../ traversal paths, preserves target containment, and exposes the code to audit consumers", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-traversal-poc-"));
  const backup_id = "2026-04-21T00-00-00Z";
  const restoreTarget = join(homeDir, "sandbox/a/b/restore-target");
  const escapedWritePath = join(homeDir, "sandbox/a/payload.txt");
  const manifestPath = "restore-target/../../payload.txt";
  const payload = "malicious payload";
  const logs: LogRecord[] = [];

  try {
    mkdirSync(restoreTarget, { recursive: true });

    const manifest = buildManifest({
      backup_id,
      now: new Date("2026-04-21T00:00:00.000Z"),
      files: [
        {
          relative_path: manifestPath,
          size: Buffer.byteLength(payload),
          sha256: sha256(payload)
        }
      ]
    });
    const backupPath = writeBackupFixture({
      homeDir,
      backup_id,
      manifest,
      targets: [
        {
          root_name: "restore-target",
          source_path: restoreTarget,
          kind: "directory"
        }
      ]
    });
    writeFile(join(backupPath, "..", "payload.txt"), payload);

    const logger = createLogger({ output: (record) => logs.push(record) });
    const result = await restoreBackup({
      backup_id,
      mode: "full",
      homeDir,
      logger
    });

    assert.equal(result.verified, false);
    assert.equal(result.files_restored, 0);
    assert.deepEqual(result.mismatches, ["UNSAFE_TRAVERSAL_SEGMENT"]);
    assert.deepEqual(result.error, {
      code: "UNSAFE_TRAVERSAL_SEGMENT",
      path: manifestPath,
      message: 'Unsafe backup path "' + manifestPath + '" contains traversal segments after normalization.'
    });
    assert.equal(existsSync(escapedWritePath), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, "warn");
    assert.equal(logs[0]?.message, "Restore rejected unsafe manifest path.");
    assert.equal(logs[0]?.context?.backup_id, backup_id);
    assert.equal(logs[0]?.context?.manifest_id, backup_id);
    assert.equal(logs[0]?.context?.error_code, "UNSAFE_TRAVERSAL_SEGMENT");
    assert.equal(logs[0]?.context?.status, "rejected");
    assert.equal(logs[0]?.context?.relative_path, manifestPath);

    const db = new SQLiteAdapter(":memory:");

    try {
      applyRestoreAuditMigration(db);
      recordRestoreAudit(db, {
        backup_id,
        mode: "full",
        operator: "tester",
        before_state_sha256: result.before_state_sha256 ?? null,
        after_state_sha256: result.after_state_sha256 ?? null,
        restored_at: Date.parse(result.restored_at),
        verified: result.verified,
        mismatches: result.mismatches
      });

      assert.deepEqual(listRestoreAudit(db, { limit: 1 })[0]?.mismatches, ["UNSAFE_TRAVERSAL_SEGMENT"]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("restoreBackup rejects absolute manifest paths", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-absolute-path-"));
  const backup_id = "2026-04-21T00-00-01Z";
  const manifestPath = "/etc/passwd";

  try {
    const manifest = buildManifest({
      backup_id,
      now: new Date("2026-04-21T00:00:01.000Z"),
      files: [
        {
          relative_path: manifestPath,
          size: 1,
          sha256: sha256("x")
        }
      ]
    });
    writeBackupFixture({ homeDir, backup_id, manifest });

    const result = await restoreBackup({
      backup_id,
      mode: "full",
      homeDir
    });

    assert.equal(result.verified, false);
    assert.equal(result.files_restored, 0);
    assert.deepEqual(result.mismatches, ["UNSAFE_ABSOLUTE_PATH"]);
    assert.equal(result.error?.code, "UNSAFE_ABSOLUTE_PATH");
    assert.equal(result.error?.path, manifestPath);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("restoreBackup rejects manifest paths containing null bytes", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-null-byte-"));
  const backup_id = "2026-04-21T00-00-02Z";
  const manifestPath = "restore-target/\0payload.txt";

  try {
    const manifest = buildManifest({
      backup_id,
      now: new Date("2026-04-21T00:00:02.000Z"),
      files: [
        {
          relative_path: manifestPath,
          size: 1,
          sha256: sha256("x")
        }
      ]
    });
    writeBackupFixture({ homeDir, backup_id, manifest });

    const result = await restoreBackup({
      backup_id,
      mode: "full",
      homeDir
    });

    assert.equal(result.verified, false);
    assert.equal(result.files_restored, 0);
    assert.deepEqual(result.mismatches, ["UNSAFE_NULL_BYTE"]);
    assert.equal(result.error?.code, "UNSAFE_NULL_BYTE");
    assert.equal(result.error?.path, manifestPath);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("verifyManifest rejects traversal entries without reading outside the backup directory", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-verify-traversal-"));
  const backupPath = join(homeDir, ".vega/backups/2026-04-21T00-00-03Z");
  const leakPath = join(backupPath, "..", "leak.txt");
  const reads: string[] = [];

  try {
    writeFile(leakPath, "leak");

    const manifest = buildManifest({
      backup_id: "2026-04-21T00-00-03Z",
      now: new Date("2026-04-21T00:00:03.000Z"),
      files: [
        {
          relative_path: "../leak.txt",
          size: Buffer.byteLength("leak"),
          sha256: sha256("leak")
        }
      ]
    });

    const verification = verifyManifest(manifest, {
      expectedBasePath: backupPath,
      readFile: (path) => {
        reads.push(path);
        return readFileSync(path);
      }
    });

    assert.equal(verification.ok, false);
    assert.deepEqual(verification.mismatches, ["UNSAFE_TRAVERSAL_SEGMENT"]);
    assert.deepEqual(verification.error, {
      code: "UNSAFE_TRAVERSAL_SEGMENT",
      path: "../leak.txt",
      message: 'Unsafe backup path "../leak.txt" contains traversal segments after normalization.'
    });
    assert.deepEqual(reads, []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("restoreBackup accepts legitimate nested paths and restores under the target root", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-legit-nested-"));
  const backup_id = "2026-04-21T00-00-04Z";
  const restoreTarget = join(homeDir, "restore-target");
  const relative_path = "restore-target/subdir/file.txt";
  const payload = "nested content";

  try {
    const manifest = buildManifest({
      backup_id,
      now: new Date("2026-04-21T00:00:04.000Z"),
      files: [
        {
          relative_path,
          size: Buffer.byteLength(payload),
          sha256: sha256(payload)
        }
      ]
    });
    const backupPath = writeBackupFixture({
      homeDir,
      backup_id,
      manifest,
      targets: [
        {
          root_name: "restore-target",
          source_path: restoreTarget,
          kind: "directory"
        }
      ]
    });
    writeFile(join(backupPath, relative_path), payload);

    const result = await restoreBackup({
      backup_id,
      mode: "full",
      homeDir
    });

    assert.equal(result.verified, true);
    assert.equal(result.files_restored, 1);
    assert.deepEqual(result.mismatches, []);
    assert.equal(readFileSync(join(restoreTarget, "subdir/file.txt"), "utf8"), payload);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("restoreBackup rejects the whole manifest without writing any safe files when one entry traverses", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-fail-closed-"));
  const backup_id = "2026-04-21T00-00-05Z";
  const restoreTarget = join(homeDir, "sandbox/a/b/restore-target");
  const safeA = "restore-target/safe-a.txt";
  const safeB = "restore-target/nested/safe-b.txt";
  const unsafe = "restore-target/../../payload.txt";

  try {
    mkdirSync(restoreTarget, { recursive: true });
    writeFile(join(restoreTarget, "safe-a.txt"), "mutated-a");
    writeFile(join(restoreTarget, "nested/safe-b.txt"), "mutated-b");

    const manifest = buildManifest({
      backup_id,
      now: new Date("2026-04-21T00:00:05.000Z"),
      files: [
        {
          relative_path: safeA,
          size: Buffer.byteLength("original-a"),
          sha256: sha256("original-a")
        },
        {
          relative_path: safeB,
          size: Buffer.byteLength("original-b"),
          sha256: sha256("original-b")
        },
        {
          relative_path: unsafe,
          size: Buffer.byteLength("payload"),
          sha256: sha256("payload")
        }
      ]
    });
    const backupPath = writeBackupFixture({
      homeDir,
      backup_id,
      manifest,
      targets: [
        {
          root_name: "restore-target",
          source_path: restoreTarget,
          kind: "directory"
        }
      ]
    });
    writeFile(join(backupPath, safeA), "original-a");
    writeFile(join(backupPath, safeB), "original-b");
    writeFile(join(backupPath, "..", "payload.txt"), "payload");

    const result = await restoreBackup({
      backup_id,
      mode: "full",
      homeDir
    });

    assert.equal(result.verified, false);
    assert.equal(result.files_restored, 0);
    assert.equal(result.error?.code, "UNSAFE_TRAVERSAL_SEGMENT");
    assert.equal(readFileSync(join(restoreTarget, "safe-a.txt"), "utf8"), "mutated-a");
    assert.equal(readFileSync(join(restoreTarget, "nested/safe-b.txt"), "utf8"), "mutated-b");
    assert.equal(existsSync(join(homeDir, "sandbox/a/payload.txt")), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
