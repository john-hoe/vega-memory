import assert from "node:assert/strict";
import test from "node:test";

import { createLogger, type LogRecord } from "../core/logging/index.js";
import { SourceRegistry, type SourceAdapter } from "../retrieval/index.js";

const createAdapter = (overrides: Partial<SourceAdapter> = {}): SourceAdapter => ({
  kind: "wiki",
  name: "wiki",
  enabled: true,
  search: () => [],
  ...overrides
});

const createInput = () => ({
  request: {
    intent: "lookup" as const,
    mode: "L1" as const,
    query: "vega",
    surface: "codex" as const,
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory"
  },
  top_k: 3,
  depth: "standard" as const
});

test("register and get round-trip registered adapters", () => {
  const registry = new SourceRegistry();
  const adapter = createAdapter();

  registry.register(adapter);

  assert.equal(registry.get("wiki"), adapter);
});

test("register rejects duplicate source kinds", () => {
  const registry = new SourceRegistry();

  registry.register(createAdapter());

  assert.throws(
    () => registry.register(createAdapter({ name: "wiki-2" })),
    /already registered/u
  );
});

test("list returns all registered adapters", () => {
  const registry = new SourceRegistry();
  const wiki = createAdapter({ kind: "wiki", name: "wiki" });
  const archive = createAdapter({ kind: "archive", name: "archive" });

  registry.register(wiki);
  registry.register(archive);

  assert.deepEqual(registry.list(), [wiki, archive]);
});

test("searchMany skips disabled adapters", () => {
  const registry = new SourceRegistry();

  registry.register(
    createAdapter({
      kind: "candidate",
      name: "candidate",
      enabled: false,
      search: () => {
        throw new Error("disabled adapters should not be called");
      }
    })
  );
  registry.register(
    createAdapter({
      kind: "wiki",
      name: "wiki",
      search: () => [
        {
          id: "wiki-1",
          source_kind: "wiki",
          content: "wiki result",
          provenance: {
            origin: "wiki:page-1",
            retrieved_at: "2026-04-17T00:00:00.000Z"
          }
        }
      ]
    })
  );

  const results = registry.searchMany(["candidate", "wiki"], createInput());

  assert.deepEqual(results.map((record) => record.id), ["wiki-1"]);
});

test("searchMany logs warnings and continues when an adapter throws", () => {
  const records: LogRecord[] = [];
  const registry = new SourceRegistry({
    logger: createLogger({
      output: (record) => {
        records.push(record);
      }
    })
  });

  registry.register(
    createAdapter({
      kind: "fact_claim",
      name: "fact-claim",
      search: () => {
        throw new Error("boom");
      }
    })
  );
  registry.register(
    createAdapter({
      kind: "archive",
      name: "archive",
      search: () => [
        {
          id: "archive-1",
          source_kind: "archive",
          content: "archive result",
          provenance: {
            origin: "archive:1",
            retrieved_at: "2026-04-17T00:00:00.000Z"
          }
        }
      ]
    })
  );

  const results = registry.searchMany(["fact_claim", "archive"], createInput());

  assert.deepEqual(results.map((record) => record.id), ["archive-1"]);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.level, "warn");
  assert.match(records[0]?.message ?? "", /Source adapter search failed/u);
});
