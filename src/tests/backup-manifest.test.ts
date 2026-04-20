import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { buildManifest, verifyManifest } from "../backup/manifest.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const writeFile = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
};

test("buildManifest creates the evidence chain hash from manifest files only", () => {
  const manifest = buildManifest({
    backup_id: "2026-04-20T12-34-56Z",
    now: new Date("2026-04-20T12:34:56.000Z"),
    files: [
      { relative_path: "vega.db", size: 10, sha256: "sha-a" },
      { relative_path: "notes/index.md", size: 20, sha256: "sha-b" },
      { relative_path: "metrics.json", size: 30, sha256: "sha-c" }
    ]
  });

  assert.equal(manifest.schema_version, "1.0");
  assert.equal(manifest.created_at, "2026-04-20T12:34:56.000Z");
  assert.equal(manifest.created_by, "vega-backup");
  assert.equal(
    manifest.manifest_sha256,
    createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex")
  );
});

test("verifyManifest passes when file hashes and manifest hash match", () => {
  const directory = mkdtempSync(join(tmpdir(), "vega-backup-manifest-ok-"));

  try {
    writeFile(join(directory, "vega.db"), "sqlite bytes");
    writeFile(join(directory, "docs/notes.md"), "note body");

    const manifest = buildManifest({
      backup_id: "2026-04-20T12-34-56Z",
      now: new Date("2026-04-20T12:34:56.000Z"),
      files: [
        {
          relative_path: "vega.db",
          size: Buffer.byteLength("sqlite bytes"),
          sha256: sha256("sqlite bytes")
        },
        {
          relative_path: "docs/notes.md",
          size: Buffer.byteLength("note body"),
          sha256: sha256("note body")
        }
      ]
    });

    assert.deepEqual(verifyManifest(manifest, { expectedBasePath: directory }), {
      ok: true,
      mismatches: []
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verifyManifest reports per-file mismatches when backup file content changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "vega-backup-manifest-file-mismatch-"));

  try {
    writeFile(join(directory, "vega.db"), "sqlite bytes");
    writeFile(join(directory, "docs/notes.md"), "note body");

    const manifest = buildManifest({
      backup_id: "2026-04-20T12-34-56Z",
      now: new Date("2026-04-20T12:34:56.000Z"),
      files: [
        {
          relative_path: "vega.db",
          size: Buffer.byteLength("sqlite bytes"),
          sha256: sha256("sqlite bytes")
        },
        {
          relative_path: "docs/notes.md",
          size: Buffer.byteLength("note body"),
          sha256: sha256("note body")
        }
      ]
    });

    writeFile(join(directory, "docs/notes.md"), "tampered note body");

    const verification = verifyManifest(manifest, { expectedBasePath: directory });

    assert.equal(verification.ok, false);
    assert.deepEqual(verification.mismatches, ["docs/notes.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verifyManifest reports manifest_sha256 mismatches without flagging healthy files", () => {
  const directory = mkdtempSync(join(tmpdir(), "vega-backup-manifest-root-mismatch-"));

  try {
    writeFile(join(directory, "vega.db"), "sqlite bytes");

    const manifest = buildManifest({
      backup_id: "2026-04-20T12-34-56Z",
      now: new Date("2026-04-20T12:34:56.000Z"),
      files: [
        {
          relative_path: "vega.db",
          size: Buffer.byteLength("sqlite bytes"),
          sha256: sha256("sqlite bytes")
        }
      ]
    });

    const verification = verifyManifest(
      {
        ...manifest,
        manifest_sha256: "not-the-right-hash"
      },
      { expectedBasePath: directory }
    );

    assert.equal(verification.ok, false);
    assert.deepEqual(verification.mismatches, ["manifest_sha256"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
