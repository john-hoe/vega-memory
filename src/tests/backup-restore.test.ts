import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdtempSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { DEFAULT_BACKUP_CONFIG, type BackupConfig } from "../backup/registry.js";
import { restoreBackup, runRestoreDrill } from "../backup/restore.js";
import { createBackup } from "../backup/trigger.js";

const writeFile = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
};

const createConfig = (targets: string[], overrides: Partial<BackupConfig> = {}): BackupConfig => ({
  ...DEFAULT_BACKUP_CONFIG,
  targets,
  ...overrides,
  retention: {
    ...DEFAULT_BACKUP_CONFIG.retention,
    ...(overrides.retention ?? {})
  },
  scheduler: {
    ...DEFAULT_BACKUP_CONFIG.scheduler,
    ...(overrides.scheduler ?? {})
  },
  exclude_globs: overrides.exclude_globs ?? []
});

test("restoreBackup restores all files on the happy full-restore path", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-restore-full-"));
  const sourcePath = join(homeDir, ".vega/data/vega.db");
  writeFile(sourcePath, "original bytes");

  try {
    const backup = await createBackup({
      config: createConfig([sourcePath]),
      homeDir,
      now: new Date("2026-04-20T12:34:56.000Z")
    });
    writeFile(sourcePath, "mutated bytes");

    const result = await restoreBackup({
      backup_id: backup.backup_id,
      mode: "full",
      homeDir
    });

    assert.equal(result.verified, true);
    assert.equal(result.files_restored, 1);
    assert.deepEqual(result.mismatches, []);
    assert.equal(readFileSync(sourcePath, "utf8"), "original bytes");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("restoreBackup selective mode only restores the requested manifest entries", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-restore-selective-"));
  const sourceA = join(homeDir, "notes/a.txt");
  const sourceB = join(homeDir, "logs/b.txt");
  writeFile(sourceA, "alpha");
  writeFile(sourceB, "beta");

  try {
    const backup = await createBackup({
      config: createConfig([sourceA, sourceB]),
      homeDir,
      now: new Date("2026-04-20T12:34:56.000Z")
    });
    const manifest = JSON.parse(readFileSync(join(backup.path, "manifest.json"), "utf8")) as {
      files: Array<{ relative_path: string }>;
    };

    writeFile(sourceA, "changed-alpha");
    writeFile(sourceB, "changed-beta");

    const result = await restoreBackup({
      backup_id: backup.backup_id,
      mode: "selective",
      selective: {
        files: [manifest.files[0]?.relative_path ?? ""]
      },
      homeDir
    });

    assert.equal(result.verified, true);
    assert.equal(result.files_restored, 1);
    assert.equal(readFileSync(sourceA, "utf8"), "alpha");
    assert.equal(readFileSync(sourceB, "utf8"), "changed-beta");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("restoreBackup dryRun verifies without writing files back", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-restore-dry-run-"));
  const sourcePath = join(homeDir, ".vega/data/vega.db");
  writeFile(sourcePath, "original bytes");

  try {
    const backup = await createBackup({
      config: createConfig([sourcePath]),
      homeDir,
      now: new Date("2026-04-20T12:34:56.000Z")
    });
    writeFile(sourcePath, "mutated bytes");

    const result = await restoreBackup({
      backup_id: backup.backup_id,
      mode: "full",
      dryRun: true,
      homeDir
    });

    assert.equal(result.verified, true);
    assert.equal(result.files_restored, 0);
    assert.equal(readFileSync(sourcePath, "utf8"), "mutated bytes");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("restoreBackup refuses to write when manifest verification finds mismatches", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-restore-mismatch-"));
  const sourcePath = join(homeDir, ".vega/data/vega.db");
  writeFile(sourcePath, "original bytes");

  try {
    const backup = await createBackup({
      config: createConfig([sourcePath]),
      homeDir,
      now: new Date("2026-04-20T12:34:56.000Z")
    });
    writeFile(join(backup.path, "vega.db"), "tampered backup bytes");
    writeFile(sourcePath, "mutated bytes");

    const result = await restoreBackup({
      backup_id: backup.backup_id,
      mode: "full",
      homeDir
    });

    assert.equal(result.verified, false);
    assert.deepEqual(result.mismatches, ["vega.db"]);
    assert.equal(result.files_restored, 0);
    assert.equal(readFileSync(sourcePath, "utf8"), "mutated bytes");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("runRestoreDrill returns backup_missing when the requested backup does not exist", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-restore-missing-"));

  try {
    const result = await runRestoreDrill({
      backup_id: "2026-04-20T12-34-56Z",
      homeDir
    });

    assert.equal(result.verified, false);
    assert.equal(result.degraded, "backup_missing");
    assert.deepEqual(result.mismatches, []);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
