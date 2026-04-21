import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { applyHostMemoryFileFtsMigration } from "../retrieval/sources/host-memory-file-fts.js";
import {
  HostMemoryFileAdapter,
  type HostMemoryFileReader
} from "../retrieval/sources/host-memory-file.js";
import type { SourceSearchInput } from "../retrieval/sources/types.js";

const HOST_MEMORY_FILE_SOURCES = [
  "src/retrieval/sources/host-memory-file.ts",
  "src/retrieval/sources/host-memory-file-fts.ts",
  "src/retrieval/sources/host-memory-file-paths.ts",
  "src/retrieval/sources/host-memory-file-parser.ts"
] as const;
const BANNED_FS_SPECIFIERS = [
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "ftruncate",
  "ftruncateSync",
  "link",
  "linkSync",
  "mkdir",
  "mkdirSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
  "writev",
  "writevSync"
] as const;
const OPEN_CALL_NAMES: readonly string[] = ["open", "openSync"];
const BANNED_FS_MODULE_IMPORT_PATTERN =
  /^import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]((?:node:)?fs(?:\/promises)?)['"]/gmu;

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function collectReadOnlyGuardViolations(source: string, filePath: string): string[] {
  const violations: string[] = [];
  const bannedSpecifiers = new Set<string>(BANNED_FS_SPECIFIERS);

  for (const match of source.matchAll(BANNED_FS_MODULE_IMPORT_PATTERN)) {
    const specifiersBlock = match[1] ?? "";
    const moduleName = match[2] ?? "";
    const specifiers = specifiersBlock
      .split(",")
      .map((specifier) => specifier.trim())
      .filter((specifier) => specifier.length > 0);

    for (const specifier of specifiers) {
      const importedName = specifier.replace(/^type\s+/u, "").split(/\s+as\s+/iu)[0]?.trim() ?? "";

      if (bannedSpecifiers.has(importedName)) {
        violations.push(`${filePath}: import ${importedName} from ${moduleName}`);
      }
    }
  }

  for (const specifier of BANNED_FS_SPECIFIERS.filter((name) => !OPEN_CALL_NAMES.includes(name))) {
    const callPattern = new RegExp(`\\b(?:\\w+\\.)*${escapeForRegex(specifier)}\\s*\\(`, "gu");

    for (const match of source.matchAll(callPattern)) {
      violations.push(`${filePath}: ${match[0].trim()}`);
    }
  }

  const openPattern = /\b(?:\w+\.)*open(?:Sync)?\s*\(\s*[^,]+,\s*(['"])([^'"\\]*(?:\\.[^'"\\]*)*)\1/gu;

  for (const match of source.matchAll(openPattern)) {
    const flag = match[2] ?? "";

    if (/[wa]/u.test(flag)) {
      violations.push(`${filePath}: ${match[0].trim()}`);
    }
  }

  return [...new Set(violations)];
}

function createSearchInput(query: string, top_k = 5): SourceSearchInput {
  return {
    request: {
      intent: "lookup",
      mode: "L1",
      query,
      surface: "codex",
      session_id: "host-memory-file-readonly-guard-session",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory"
    },
    top_k,
    depth: "standard"
  };
}

function createHarness(prefix: string): {
  db: SQLiteAdapter;
  homeDir: string;
  cleanup(): void;
} {
  const homeDir = mkdtempSync(join(tmpdir(), prefix));
  const db = new SQLiteAdapter(":memory:");
  applyHostMemoryFileFtsMigration(db);

  return {
    db,
    homeDir,
    cleanup() {
      db.close();
      rmSync(homeDir, { recursive: true, force: true });
    }
  };
}

function writeHomeFile(homeDir: string, relativePath: string, content: string): string {
  const fullPath = join(homeDir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

test("HostMemoryFileAdapter exposes only search, refreshIndex, and dispose as public methods", () => {
  const harness = createHarness("vega-host-memory-readonly-methods-");

  try {
    writeHomeFile(
      harness.homeDir,
      ".claude/CLAUDE.md",
      "---\ntitle: Claude Memory\n---\nreadonly guard keyword"
    );

    const adapter = new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });
    const publicMethodNames = Object.entries(
      Object.getOwnPropertyDescriptors(Object.getPrototypeOf(adapter))
    )
      .filter(([, descriptor]) => typeof descriptor.value === "function")
      .map(([name]) => name)
      .filter((name) => name !== "constructor")
      .sort();

    assert.deepEqual(publicMethodNames, ["dispose", "refreshIndex", "search"]);
    const adapterRecord = adapter as unknown as Record<string, unknown>;

    assert.equal(typeof adapterRecord.writeFile, "undefined");
    assert.equal(typeof adapterRecord.appendFile, "undefined");
    assert.equal(typeof adapterRecord.write, "undefined");
    assert.equal(typeof adapterRecord.remove, "undefined");
    assert.equal(typeof adapterRecord.setIndex, "undefined");
    assert.equal(typeof adapterRecord.deleteIndex, "undefined");
    assert.equal(
      publicMethodNames.some((name) => /^(write|append|set|delete)/u.test(name)),
      false
    );

    adapter.dispose();
  } finally {
    harness.cleanup();
  }
});

test("HostMemoryFileAdapter satisfies HostMemoryFileReader and works through the read-only interface", () => {
  const harness = createHarness("vega-host-memory-readonly-interface-");

  try {
    const claudePath = writeHomeFile(
      harness.homeDir,
      ".claude/CLAUDE.md",
      "---\ntitle: Claude Memory\n---\nreadonly contract keyword"
    );

    const adapter = new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });
    const reader: HostMemoryFileReader = adapter;

    reader.refreshIndex();
    const results = reader.search(createSearchInput("readonly"));

    assert.equal(results.length > 0, true);
    assert.equal(results[0]?.provenance.origin, claudePath);
    reader.dispose();
  } finally {
    harness.cleanup();
  }
});

test("host-memory-file source files contain no forbidden write-oriented fs APIs", () => {
  const matches = HOST_MEMORY_FILE_SOURCES.flatMap((filePath) =>
    collectReadOnlyGuardViolations(readFileSync(filePath, "utf8"), filePath)
  );

  assert.deepEqual(matches, []);
});

test("readonly scanner flags aliased write imports", () => {
  const matches = collectReadOnlyGuardViolations(
    `import { writeFileSync as wf } from "node:fs";
wf("/tmp/x", "y");`,
    "mock-alias.ts"
  );

  assert.equal(matches.some((match) => match.includes("writeFileSync")), true);
});

test("readonly scanner flags fs.promises write calls", () => {
  const matches = collectReadOnlyGuardViolations(
    `import { promises } from "node:fs";
promises.writeFile("/tmp/x", "y");`,
    "mock-promises.ts"
  );

  assert.equal(matches.some((match) => match.includes("promises.writeFile")), true);
});

test("readonly scanner flags fsp alias for fs.promises write calls", () => {
  const matches = collectReadOnlyGuardViolations(
    `import { promises as fsp } from "node:fs";
async function leak() {
  await fsp.writeFile("/tmp/x", "y");
}`,
    "mock-fsp.ts"
  );

  assert.ok(matches.length >= 1, `expected at least 1 violation, got ${matches.length}`);
  assert.equal(matches.some((match) => match.includes("writeFile")), true);
});

test("readonly scanner flags open calls that use write-like flags", () => {
  const matches = collectReadOnlyGuardViolations(
    `import { open } from "node:fs";
open("/tmp/x", "w");`,
    "mock-open.ts"
  );

  assert.equal(matches.some((match) => match.includes('open("/tmp/x", "w"')), true);
});
