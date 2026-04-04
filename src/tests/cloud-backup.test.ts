import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CloudBackupProvider } from "../db/cloud-backup.js";

const createProvider = (destDir: string): CloudBackupProvider =>
  new CloudBackupProvider({
    enabled: true,
    provider: "local-sync",
    destDir
  });

test("upload copies file to destination directory", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cloud-backup-upload-"));
  const localPath = join(tempDir, "memory-2026-04-04.db");
  const destDir = join(tempDir, "cloud");
  const provider = createProvider(destDir);

  try {
    writeFileSync(localPath, "backup-content", "utf8");

    const remoteName = await provider.upload(localPath);
    const uploadedPath = join(destDir, remoteName);

    assert.equal(remoteName, "memory-2026-04-04.db");
    assert.equal(readFileSync(uploadedPath, "utf8"), "backup-content");
    assert.equal(existsSync(join(destDir, "memory-2026-04-04.db.metadata.json")), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("listBackups returns uploaded files", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cloud-backup-list-"));
  const destDir = join(tempDir, "cloud");
  const provider = createProvider(destDir);

  try {
    for (const [name, timestamp] of [
      ["memory-2026-04-03.db", "2026-04-03T00:00:00.000Z"],
      ["memory-2026-04-04.db", "2026-04-04T00:00:00.000Z"]
    ] as const) {
      const localPath = join(tempDir, name);
      writeFileSync(localPath, name, "utf8");
      utimesSync(localPath, new Date(timestamp), new Date(timestamp));
      await provider.upload(localPath);
    }

    const backups = await provider.listBackups();

    assert.deepEqual(backups, ["memory-2026-04-04.db", "memory-2026-04-03.db"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("download retrieves file", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cloud-backup-download-"));
  const localPath = join(tempDir, "memory-2026-04-04.db");
  const destDir = join(tempDir, "cloud");
  const downloadPath = join(tempDir, "restored", "memory.db");
  const provider = createProvider(destDir);

  try {
    writeFileSync(localPath, "download-me", "utf8");

    const remoteName = await provider.upload(localPath);
    await provider.download(remoteName, downloadPath);

    assert.equal(readFileSync(downloadPath, "utf8"), "download-me");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
