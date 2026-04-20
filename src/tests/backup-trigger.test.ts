import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
  mkdtempSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { DEFAULT_BACKUP_CONFIG, type BackupConfig } from "../backup/registry.js";
import { applyBackupRetention, createBackup } from "../backup/trigger.js";

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

test("createBackup copies a file target, writes manifest metadata, and reports totals", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-trigger-file-"));
  const sourcePath = join(homeDir, ".vega/data/vega.db");
  writeFile(sourcePath, "db-bytes");

  try {
    const result = await createBackup({
      config: createConfig([sourcePath]),
      homeDir,
      now: new Date("2026-04-20T12:34:56.000Z")
    });

    assert.equal(result.file_count, 1);
    assert.equal(result.total_bytes, Buffer.byteLength("db-bytes"));
    assert.equal(result.degraded, undefined);
    assert.equal(
      readFileSync(join(result.path, "vega.db"), "utf8"),
      "db-bytes"
    );
    assert.equal(existsSync(join(result.path, "manifest.json")), true);
    assert.equal(existsSync(join(result.path, "targets.json")), true);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createBackup recurses directory targets and honors exclude_globs", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-trigger-dir-"));
  const targetDir = join(homeDir, "source");
  writeFile(join(targetDir, "keep.txt"), "keep");
  writeFile(join(targetDir, "nested/skip.log"), "skip");

  try {
    const result = await createBackup({
      config: createConfig([targetDir], {
        exclude_globs: ["*.log", "**/*.log"]
      }),
      homeDir,
      now: new Date("2026-04-20T12:34:56.000Z")
    });

    assert.equal(result.file_count, 1);
    assert.deepEqual(readdirSync(result.path).sort(), ["manifest.json", "source", "targets.json"]);
    assert.equal(readFileSync(join(result.path, "source/keep.txt"), "utf8"), "keep");
    assert.equal(existsSync(join(result.path, "source/nested/skip.log")), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("applyBackupRetention prunes only backups that exceed max_count and min_days", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-retention-"));
  const backupsRoot = join(homeDir, ".vega/backups");
  mkdirSync(backupsRoot, { recursive: true });

  try {
    const names = [
      "2026-04-20T12-00-00Z",
      "2026-04-19T12-00-00Z",
      "2026-04-16T12-00-00Z"
    ];
    for (const name of names) {
      mkdirSync(join(backupsRoot, name), { recursive: true });
    }

    utimesSync(
      join(backupsRoot, names[0]),
      new Date("2026-04-20T12:00:00.000Z"),
      new Date("2026-04-20T12:00:00.000Z")
    );
    utimesSync(
      join(backupsRoot, names[1]),
      new Date("2026-04-19T12:00:00.000Z"),
      new Date("2026-04-19T12:00:00.000Z")
    );
    utimesSync(
      join(backupsRoot, names[2]),
      new Date("2026-04-16T12:00:00.000Z"),
      new Date("2026-04-16T12:00:00.000Z")
    );

    const result = applyBackupRetention({
      backupsRoot,
      retention: {
        max_count: 1,
        min_days: 2
      },
      now: new Date("2026-04-20T12:00:00.000Z")
    });

    assert.equal(result.pruned_count, 1);
    assert.deepEqual(readdirSync(backupsRoot).sort(), [names[1], names[0]].sort());
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createBackup is inert when no targets are configured", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-trigger-empty-"));

  try {
    const result = await createBackup({
      config: createConfig([]),
      homeDir,
      now: new Date("2026-04-20T12:34:56.000Z")
    });

    assert.equal(result.file_count, 0);
    assert.equal(result.total_bytes, 0);
    assert.equal(result.degraded, undefined);
    assert.equal(existsSync(result.path), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("createBackup returns a degraded partial result instead of throwing on IO errors", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "vega-backup-trigger-error-"));
  const missingPath = join(homeDir, "missing.db");

  try {
    await assert.doesNotReject(async () => {
      const result = await createBackup({
        config: createConfig([missingPath]),
        homeDir,
        now: new Date("2026-04-20T12:34:56.000Z")
      });

      assert.equal(result.degraded, "file_read_error");
      assert.equal(result.file_count, 0);
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
