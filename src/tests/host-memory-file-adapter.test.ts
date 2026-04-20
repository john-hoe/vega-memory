import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  applyHostMemoryFileFtsMigration,
  HOST_MEMORY_FILE_ENTRIES_TABLE
} from "../retrieval/sources/host-memory-file-fts.js";
import { HostMemoryFileAdapter } from "../retrieval/sources/host-memory-file.js";
import {
  parseJson,
  parseMarkdownFrontmatter,
  parsePlainText
} from "../retrieval/sources/host-memory-file-parser.js";
import { enumeratePaths } from "../retrieval/sources/host-memory-file-paths.js";
import type { SourceSearchInput } from "../retrieval/sources/types.js";

interface EntryRow {
  path: string;
  indexed_at: number;
}

function createSearchInput(query: string, top_k = 5): SourceSearchInput {
  return {
    request: {
      intent: "lookup",
      mode: "L1",
      query,
      surface: "codex",
      session_id: "host-memory-file-session",
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

function readEntries(db: SQLiteAdapter): EntryRow[] {
  return db.all<EntryRow>(
    `SELECT path, indexed_at FROM ${HOST_MEMORY_FILE_ENTRIES_TABLE} ORDER BY path ASC`
  );
}

test("HostMemoryFileAdapter defaults enabled and can be opted out with VEGA_HOST_MEMORY_FILE_ENABLED=false", () => {
  const original = process.env.VEGA_HOST_MEMORY_FILE_ENABLED;
  const harness = createHarness("vega-host-memory-enabled-");

  try {
    delete process.env.VEGA_HOST_MEMORY_FILE_ENABLED;
    const enabledAdapter = new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });
    assert.equal(enabledAdapter.enabled, true);

    process.env.VEGA_HOST_MEMORY_FILE_ENABLED = "false";
    const disabledAdapter = new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });
    assert.equal(disabledAdapter.enabled, false);
  } finally {
    if (original === undefined) {
      delete process.env.VEGA_HOST_MEMORY_FILE_ENABLED;
    } else {
      process.env.VEGA_HOST_MEMORY_FILE_ENABLED = original;
    }
    harness.cleanup();
  }
});

test("enumeratePaths discovers fixture host-memory files under the injected HOME", () => {
  const harness = createHarness("vega-host-memory-paths-");

  try {
    const claudePath = writeHomeFile(harness.homeDir, ".claude/CLAUDE.md", "# Claude memory");
    const cursorPath = writeHomeFile(
      harness.homeDir,
      ".cursor/rules/memory.mdc",
      "---\ntitle: Cursor memory\n---\nBody"
    );

    const entries = enumeratePaths(harness.homeDir);
    const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));

    assert.equal(entryByPath.get(claudePath)?.surface, "claude");
    assert.equal(entryByPath.get(cursorPath)?.surface, "cursor");
  } finally {
    harness.cleanup();
  }
});

test("parsers handle markdown frontmatter, plain text, and malformed JSON fallback", () => {
  const markdown = parseMarkdownFrontmatter("---\ntitle: Claude Memory\nsurface: claude\n---\n# Notes\nKeep this");
  assert.equal(markdown.title, "Claude Memory");
  assert.equal(markdown.frontmatter.surface, "claude");
  assert.equal(markdown.body, "# Notes\nKeep this");

  const plainText = parsePlainText("First title\nSecond line\nThird line");
  assert.equal(plainText.title, "First title");
  assert.equal(plainText.body, "Second line\nThird line");

  const malformedJson = "{\"title\":";
  assert.doesNotThrow(() => parseJson(malformedJson));
  assert.deepEqual(parseJson(malformedJson), {
    title: undefined,
    body: malformedJson
  });
});

test("HostMemoryFileAdapter indexes fixture files into FTS and returns SourceRecord-shaped search results", () => {
  const harness = createHarness("vega-host-memory-search-");

  try {
    const claudePath = writeHomeFile(
      harness.homeDir,
      ".claude/CLAUDE.md",
      "---\ntitle: Claude Memory\n---\nalpha keyword from claude"
    );
    writeHomeFile(
      harness.homeDir,
      ".cursor/rules/memory.mdc",
      "---\ntitle: Cursor Memory\n---\nbeta keyword from cursor"
    );

    const adapter = new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });
    const results = adapter.search(createSearchInput("alpha"));

    assert.equal(results.length > 0, true);
    assert.equal(results[0]?.source_kind, "host_memory_file");
    assert.equal(results[0]?.provenance.origin, claudePath);
    assert.equal(typeof results[0]?.provenance.retrieved_at, "string");
    assert.match(results[0]?.id ?? "", /^host-memory-file:.+:0$/u);
    assert.match(results[0]?.content ?? "", /alpha keyword/u);
  } finally {
    harness.cleanup();
  }
});

test("HostMemoryFileAdapter sparse re-index only refreshes entries whose mtime changes", () => {
  const harness = createHarness("vega-host-memory-reindex-");

  try {
    const claudePath = writeHomeFile(
      harness.homeDir,
      ".claude/CLAUDE.md",
      "---\ntitle: Claude Memory\n---\nalpha keyword"
    );
    const codexPath = writeHomeFile(
      harness.homeDir,
      ".codex/AGENTS.md",
      "# Codex memory\nbeta keyword"
    );

    new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });
    const firstEntries = readEntries(harness.db);
    const firstClaude = firstEntries.find((entry) => entry.path === claudePath);
    const firstCodex = firstEntries.find((entry) => entry.path === codexPath);

    assert.ok(firstClaude);
    assert.ok(firstCodex);

    const futureSeconds = Math.floor((Date.now() + 5_000) / 1_000);
    utimesSync(claudePath, futureSeconds, futureSeconds);

    new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });
    const secondEntries = readEntries(harness.db);
    const secondClaude = secondEntries.find((entry) => entry.path === claudePath);
    const secondCodex = secondEntries.find((entry) => entry.path === codexPath);

    assert.ok(secondClaude);
    assert.ok(secondCodex);
    assert.equal((secondClaude?.indexed_at ?? 0) > (firstClaude?.indexed_at ?? 0), true);
    assert.equal(secondCodex?.indexed_at, firstCodex?.indexed_at);
  } finally {
    harness.cleanup();
  }
});

test("HostMemoryFileAdapter removes stale FTS rows when a discovered file disappears", () => {
  const harness = createHarness("vega-host-memory-cleanup-");

  try {
    const claudePath = writeHomeFile(
      harness.homeDir,
      ".claude/CLAUDE.md",
      "---\ntitle: Claude Memory\n---\ncleanup keyword"
    );

    const adapter = new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });
    assert.equal(adapter.search(createSearchInput("cleanup")).length, 1);

    rmSync(claudePath, { force: true });
    new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });

    assert.deepEqual(readEntries(harness.db), []);
    assert.equal(adapter.search(createSearchInput("cleanup")).length, 0);
  } finally {
    harness.cleanup();
  }
});
