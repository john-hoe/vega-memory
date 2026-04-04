import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

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
