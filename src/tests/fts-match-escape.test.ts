import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Repository } from "../db/repository.js";
import { escapeFtsMatchQuery } from "../db/fts-query-escape.js";
import type { Memory, RawArchive } from "../core/types.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import {
  applyHostMemoryFileFtsMigration,
  HOST_MEMORY_FILE_ENTRIES_TABLE
} from "../retrieval/sources/host-memory-file-fts.js";
import { HostMemoryFileAdapter } from "../retrieval/sources/host-memory-file.js";
import type { SourceSearchInput } from "../retrieval/sources/types.js";

const NOW = "2026-04-21T00:00:00.000Z";

function createMemory(overrides: Partial<Memory> = {}): Omit<Memory, "access_count"> {
  const { summary = null, ...rest } = overrides;

  return {
    id: "mem-1",
    tenant_id: null,
    type: "decision",
    project: "vega-memory",
    title: "Alpha memory",
    content: "alpha beta memory content",
    embedding: null,
    importance: 0.8,
    source: "explicit",
    tags: ["alpha"],
    created_at: NOW,
    updated_at: NOW,
    accessed_at: NOW,
    status: "active",
    verified: "verified",
    scope: "project",
    accessed_projects: ["vega-memory"],
    source_context: null,
    ...rest,
    summary
  };
}

function createRawArchive(overrides: Partial<RawArchive> = {}): RawArchive {
  return {
    id: "archive-1",
    tenant_id: null,
    project: "vega-memory",
    source_memory_id: null,
    archive_type: "document",
    title: "Archive alpha",
    source_uri: null,
    content: "alpha beta archive content",
    content_hash: "hash-1",
    metadata: {},
    captured_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides
  };
}

function createSearchInput(query: string, top_k = 5): SourceSearchInput {
  return {
    request: {
      intent: "lookup",
      mode: "L1",
      query,
      surface: "codex",
      session_id: "fts-match-session",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory"
    },
    top_k,
    depth: "standard"
  };
}

function createHostHarness(prefix: string): {
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

test("escapeFtsMatchQuery splits punctuation-separated words into OR-quoted terms", () => {
  assert.equal(escapeFtsMatchQuery("alpha, beta"), "\"alpha\" OR \"beta\"");
});

test("escapeFtsMatchQuery returns a safe no-op matcher for empty input", () => {
  assert.equal(escapeFtsMatchQuery(""), "\"\"");
});

test("escapeFtsMatchQuery returns a safe no-op matcher for whitespace input", () => {
  assert.equal(escapeFtsMatchQuery("   "), "\"\"");
});

test("escapeFtsMatchQuery returns a safe no-op matcher for punctuation-only input", () => {
  assert.equal(escapeFtsMatchQuery("!!!"), "\"\"");
});

test("escapeFtsMatchQuery drops punctuation and quote noise while preserving word tokens", () => {
  assert.equal(escapeFtsMatchQuery("she said \"hi\""), "\"she\" OR \"said\" OR \"hi\"");
});

test("escapeFtsMatchQuery preserves CJK tokens", () => {
  assert.equal(escapeFtsMatchQuery("中文 搜索"), "\"中文\" OR \"搜索\"");
});

test("escapeFtsMatchQuery splits dotted and dashed identifiers but keeps underscore words", () => {
  assert.equal(
    escapeFtsMatchQuery("name.with-dash_underscore"),
    "\"name\" OR \"with\" OR \"dash_underscore\""
  );
});

test("repository.searchFTS accepts punctuation-heavy queries without SQLite syntax errors", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createMemory(createMemory());

    assert.doesNotThrow(() => repository.searchFTS("alpha, beta", "vega-memory", "decision"));
  } finally {
    repository.close();
  }
});

test("repository.searchRawArchives accepts punctuation-heavy queries without SQLite syntax errors", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createRawArchive(createRawArchive());

    assert.doesNotThrow(() => repository.searchRawArchives("alpha, beta", "vega-memory", 10));
  } finally {
    repository.close();
  }
});

test("HostMemoryFileAdapter.search accepts punctuation-heavy queries without SQLite syntax errors", () => {
  const harness = createHostHarness("vega-host-memory-fts-punct-");

  try {
    writeHomeFile(
      harness.homeDir,
      ".claude/CLAUDE.md",
      "---\ntitle: Claude Memory\n---\nalpha beta host memory content"
    );

    const adapter = new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });

    assert.equal(
      harness.db.all<{ path: string }>(`SELECT path FROM ${HOST_MEMORY_FILE_ENTRIES_TABLE}`).length,
      1
    );
    assert.doesNotThrow(() => adapter.search(createSearchInput("alpha, beta")));
  } finally {
    harness.cleanup();
  }
});
