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

const FORBIDDEN_WRITE_PATTERN =
  /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write|rm(?:Sync)?|unlink(?:Sync)?|mkdir(?:Sync)?|copyFile(?:Sync)?|rename(?:Sync)?|chmod(?:Sync)?|chown(?:Sync)?|truncate(?:Sync)?|createWriteStream)\b/u;

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
  const matches = HOST_MEMORY_FILE_SOURCES.flatMap((filePath) => {
    const contents = readFileSync(filePath, "utf8");
    const fileMatches = contents.match(new RegExp(FORBIDDEN_WRITE_PATTERN, "gu")) ?? [];
    return fileMatches.map((match) => `${filePath}:${match}`);
  });

  assert.deepEqual(matches, []);
});
