import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { Repository } from "../db/repository.js";

const cliPath = join(process.cwd(), "dist", "cli", "index.js");

const runCli = (args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });

test("CLI help lists core commands", () => {
  const output = runCli(["--help"], {
    VEGA_DB_PATH: ":memory:",
    OLLAMA_BASE_URL: "http://localhost:99999"
  });

  assert.match(output, /\bstore\b/);
  assert.match(output, /\brecall\b/);
  assert.match(output, /\bsession-start\b/);
  assert.match(output, /\bhealth\b/);
});

test("CLI store and list commands work together", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-store-"));
  const dbPath = join(tempDir, "memory.db");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };

  try {
    const storeOutput = runCli(
      [
        "store",
        "Remember SQLite for local search",
        "--type",
        "decision",
        "--project",
        "vega"
      ],
      env
    );
    const listOutput = runCli(["list", "--project", "vega"], env);

    assert.match(storeOutput, /\bcreated\b/);
    assert.match(listOutput, /Remember SQLite for local search/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI export and import support encrypted JSON", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-export-encrypted-"));
  const sourceDbPath = join(tempDir, "source.db");
  const targetDbPath = join(tempDir, "target.db");
  const exportPath = join(tempDir, "memories.enc.json");
  const encryptionKey =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

  try {
    runCli(
      [
        "store",
        "Persist encrypted export data",
        "--type",
        "decision",
        "--project",
        "vega"
      ],
      {
        VEGA_DB_PATH: sourceDbPath,
        VEGA_ENCRYPTION_KEY: encryptionKey,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );

    const exportOutput = runCli(
      ["export", "--format", "json", "--encrypt", "-o", exportPath],
      {
        VEGA_DB_PATH: sourceDbPath,
        VEGA_ENCRYPTION_KEY: encryptionKey,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );
    const importOutput = runCli(["import", "--decrypt", exportPath], {
      VEGA_DB_PATH: targetDbPath,
      VEGA_ENCRYPTION_KEY: encryptionKey,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });
    const listed = runCli(["list"], {
      VEGA_DB_PATH: targetDbPath,
      VEGA_ENCRYPTION_KEY: encryptionKey,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });
    const encryptedContent = readFileSync(exportPath);

    assert.match(exportOutput, /\bexported 1 memories\b/);
    assert.match(importOutput, /\bimported 1 memories\b/);
    assert.equal(
      encryptedContent.includes(Buffer.from("Persist encrypted export data", "utf8")),
      false
    );
    assert.match(listed, /Persist encrypted export data/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI export and import round-trip JSON", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-export-"));
  const sourceDbPath = join(tempDir, "source.db");
  const targetDbPath = join(tempDir, "target.db");
  const exportPath = join(tempDir, "memories.json");

  try {
    runCli(
      [
        "store",
        "Prefer concise output for CLI responses",
        "--type",
        "preference",
        "--project",
        "vega",
        "--source",
        "explicit"
      ],
      {
        VEGA_DB_PATH: sourceDbPath,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );

    const exportOutput = runCli(
      ["export", "--format", "json", "-o", exportPath],
      {
        VEGA_DB_PATH: sourceDbPath,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );
    const importOutput = runCli(["import", exportPath], {
      VEGA_DB_PATH: targetDbPath,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });
    const listed = runCli(["list"], {
      VEGA_DB_PATH: targetDbPath,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });

    assert.match(exportOutput, /\bexported 1 memories\b/);
    assert.match(importOutput, /\bimported 1 memories\b/);
    assert.match(readFileSync(exportPath, "utf8"), /Prefer concise output/);
    assert.match(listed, /Prefer concise output for CLI responses/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI JSON export/import preserves archived metadata", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-export-metadata-"));
  const sourceDbPath = join(tempDir, "source.db");
  const targetDbPath = join(tempDir, "target.db");
  const exportPath = join(tempDir, "memories.json");
  const sourceRepository = new Repository(sourceDbPath);

  try {
    sourceRepository.createMemory({
      id: "archived-global-memory",
      type: "decision",
      project: "project-a",
      title: "Archived Global Decision",
      content: "Preserve archived metadata during export and import.",
      embedding: null,
      importance: 0.6,
      source: "explicit",
      tags: ["archive", "global"],
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
      accessed_at: "2026-04-03T00:00:00.000Z",
      status: "archived",
      verified: "verified",
      scope: "global",
      accessed_projects: ["project-a", "project-b"]
    });
    sourceRepository.updateMemory(
      "archived-global-memory",
      {
        access_count: 7,
        accessed_at: "2026-04-03T00:00:00.000Z",
        updated_at: "2026-04-02T00:00:00.000Z"
      },
      {
        skipVersion: true
      }
    );

    const exportOutput = runCli(
      ["export", "--format", "json", "--archived", "-o", exportPath],
      {
        VEGA_DB_PATH: sourceDbPath,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );
    const importOutput = runCli(["import", exportPath], {
      VEGA_DB_PATH: targetDbPath,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });
    const targetRepository = new Repository(targetDbPath);

    try {
      const imported = targetRepository.getMemory("archived-global-memory");

      assert.match(exportOutput, /\bexported 1 memories\b/);
      assert.match(importOutput, /\bimported 1 memories\b/);
      assert.ok(imported);
      assert.equal(imported.status, "archived");
      assert.equal(imported.scope, "global");
      assert.equal(imported.verified, "verified");
      assert.equal(imported.source, "explicit");
      assert.equal(imported.access_count, 7);
      assert.deepEqual(imported.accessed_projects, ["project-a", "project-b"]);
      assert.match(readFileSync(exportPath, "utf8"), /"format": "vega-memory\/v1"/);
    } finally {
      targetRepository.close();
    }
  } finally {
    sourceRepository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
