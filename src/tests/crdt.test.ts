import assert from "node:assert/strict";
import test from "node:test";

import type { Memory } from "../core/types.js";
import { CRDTMerger } from "../db/crdt.js";

const createMemory = (overrides: Partial<Memory> = {}): Memory => {
  const { summary = null, ...rest } = overrides;

  return {
    id: "memory-1",
    type: "decision",
    project: "vega",
    title: "Memory",
    content: "Initial content",
    embedding: null,
    importance: 0.5,
    source: "explicit",
    tags: ["vega"],
    created_at: "2026-04-04T00:00:00.000Z",
    updated_at: "2026-04-04T00:00:00.000Z",
    accessed_at: "2026-04-04T00:00:00.000Z",
    access_count: 0,
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega"],
    ...rest,
    summary
  };
};

test("mergeMemories keeps newer version", () => {
  const merger = new CRDTMerger();
  const local = createMemory({
    id: "shared",
    content: "Local version",
    updated_at: "2026-04-04T00:00:00.000Z"
  });
  const remote = createMemory({
    id: "shared",
    content: "Remote version",
    updated_at: "2026-04-04T00:00:05.000Z"
  });

  const result = merger.mergeMemories([local], [remote]);

  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0]?.content, "Remote version");
  assert.equal(result.updated, 1);
  assert.equal(result.kept, 0);
});

test("mergeMemories adds remote-only memories", () => {
  const merger = new CRDTMerger();
  const remote = createMemory({
    id: "remote-only",
    content: "Remote only"
  });

  const result = merger.mergeMemories([], [remote]);

  assert.equal(result.added, 1);
  assert.deepEqual(
    result.merged.map((memory) => memory.id),
    ["remote-only"]
  );
});

test("mergeMemories keeps local-only memories", () => {
  const merger = new CRDTMerger();
  const local = createMemory({
    id: "local-only",
    content: "Local only"
  });

  const result = merger.mergeMemories([local], []);

  assert.equal(result.kept, 1);
  assert.deepEqual(
    result.merged.map((memory) => memory.id),
    ["local-only"]
  );
});

test("mergeMemories reports conflicts when both updated within 1 second", () => {
  const merger = new CRDTMerger();
  const local = createMemory({
    id: "shared",
    content: "Local near-simultaneous update",
    updated_at: "2026-04-04T00:00:00.000Z"
  });
  const remote = createMemory({
    id: "shared",
    content: "Remote near-simultaneous update",
    updated_at: "2026-04-04T00:00:00.500Z"
  });

  const result = merger.mergeMemories([local], [remote]);

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.id, "shared");
  assert.equal(result.merged[0]?.content, "Remote near-simultaneous update");
});

test("mergeMemories field-merges concurrent updates", () => {
  const merger = new CRDTMerger();
  const local = createMemory({
    id: "shared",
    content: "Short local content",
    tags: ["sqlite"],
    importance: 0.4,
    updated_at: "2026-04-04T00:00:00.000Z"
  });
  const remote = createMemory({
    id: "shared",
    content: "Much longer remote content that should win",
    tags: ["scheduler"],
    importance: 0.9,
    updated_at: "2026-04-04T00:00:00.500Z"
  });

  const result = merger.mergeMemories([local], [remote]);

  assert.equal(result.merged[0]?.content, "Much longer remote content that should win");
  assert.deepEqual(result.merged[0]?.tags, ["scheduler", "sqlite"]);
  assert.equal(result.merged[0]?.importance, 0.9);
  assert.equal(result.conflicts.length, 1);
});
