import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { applyHostMemoryFileFtsMigration } from "../retrieval/sources/host-memory-file-fts.js";
import { HostMemoryFileAdapter } from "../retrieval/sources/host-memory-file.js";
import {
  parseJson,
  parseMarkdownFrontmatter,
  parsePlainText
} from "../retrieval/sources/host-memory-file-parser.js";
import { createDefaultSchemaRouter } from "../retrieval/sources/host-memory-file-schema-router.js";
import type { SourceSearchInput } from "../retrieval/sources/types.js";

function createSearchInput(query: string): SourceSearchInput {
  return {
    request: {
      intent: "lookup",
      mode: "L1",
      query,
      surface: "codex",
      session_id: "host-memory-file-schema-compat-session",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory"
    },
    top_k: 5,
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

test("parseMarkdownFrontmatter emits the v1 detected format version", () => {
  const result = parseMarkdownFrontmatter("---\ntitle: X\n---\nbody");

  assert.equal(result.detected_format_version, "v1");
});

test("parsePlainText emits the v1 detected format version", () => {
  const result = parsePlainText("just text");

  assert.equal(result.detected_format_version, "v1");
});

test("parseJson emits the v1 detected format version", () => {
  const result = parseJson('{"title":"X"}');

  assert.equal(result.detected_format_version, "v1");
});

test("malformed frontmatter falls back to plain text with an unknown format version", () => {
  const content = "---\ntitle X\n---\nbody";
  const fallback = parsePlainText(content);
  const result = parseMarkdownFrontmatter(content);

  assert.equal(result.detected_format_version, "unknown");
  assert.equal(result.title, fallback.title);
  assert.equal(result.body, fallback.body);
});

test("default schema router selects a v1 parser for every supported surface", () => {
  const router = createDefaultSchemaRouter();

  for (const surface of ["cursor", "codex", "claude", "claude-projects", "omc"] as const) {
    const parser = router.selectParser({
      surface,
      contentSample: "Title line\nBody line"
    });
    const result = parser("Title line\nBody line");

    assert.equal(result.detected_format_version, "v1");
  }
});

test("default schema router selects the markdown frontmatter parser when the content signature matches", () => {
  const router = createDefaultSchemaRouter();
  const parser = router.selectParser({
    surface: "claude-projects",
    contentSample: "---\ntitle: Claude Project\n---\nbody"
  });
  const result = parser("---\ntitle: Claude Project\n---\nbody");

  assert.equal(result.detected_format_version, "v1");
  assert.equal(result.title, "Claude Project");
  assert.equal(result.body, "body");
});

test("adapter provenance carries schema_version end to end", () => {
  const harness = createHarness("vega-host-memory-schema-compat-");

  try {
    const claudePath = writeHomeFile(
      harness.homeDir,
      ".claude/CLAUDE.md",
      "---\ntitle: Claude Memory\n---\nalpha keyword"
    );
    const adapter = new HostMemoryFileAdapter({
      db: harness.db,
      homeDir: harness.homeDir
    });
    const results = adapter.search(createSearchInput("alpha"));
    const provenance = results[0]?.provenance as
      | { origin: string; retrieved_at: string; schema_version?: string }
      | undefined;

    assert.equal(provenance?.origin, claudePath);
    assert.equal(provenance?.schema_version, "v1");
  } finally {
    harness.cleanup();
  }
});
