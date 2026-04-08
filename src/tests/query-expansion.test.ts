import assert from "node:assert/strict";
import test from "node:test";

import { QueryExpander } from "../search/query-expansion.js";

test("expand returns original query first with heuristic variants", async () => {
  const expander = new QueryExpander({ enabled: true });
  const expanded = await expander.expand("database config");

  assert.equal(expanded.original, "database config");
  assert.equal(expanded.method, "heuristic");
  assert.deepEqual(expanded.variants, [
    "database config",
    "database configuration",
    "data base config"
  ]);
});

test("expand applies common tech synonym mappings", async () => {
  const expander = new QueryExpander({ enabled: true, maxVariants: 4 });
  const expanded = await expander.expand("db auth err");

  assert.equal(expanded.variants[0], "db auth err");
  assert.ok(expanded.variants.includes("database authentication error"));
  assert.ok(expanded.variants.includes("db database auth authentication err error"));
});

test("mergeResults uses reciprocal rank fusion ordering", () => {
  const expander = new QueryExpander({ enabled: true });
  const merged = expander.mergeResults([
    {
      query: "database",
      results: [
        { id: "a", score: 0.9 },
        { id: "b", score: 0.8 },
        { id: "c", score: 0.7 }
      ]
    },
    {
      query: "data base",
      results: [
        { id: "b", score: 0.95 },
        { id: "c", score: 0.85 },
        { id: "d", score: 0.75 }
      ]
    }
  ]);

  assert.deepEqual(
    merged.map((result) => result.id),
    ["b", "c", "a", "d"]
  );
  assert.ok(Math.abs((merged[0]?.score ?? 0) - (1 / 62 + 1 / 61)) < 1e-12);
  assert.ok(Math.abs((merged[2]?.score ?? 0) - 1 / 61) < 1e-12);
});

test("disabled expansion returns only the original query", async () => {
  const expander = new QueryExpander({ enabled: false });
  const expanded = await expander.expand("db auth");

  assert.deepEqual(expanded, {
    original: "db auth",
    variants: ["db auth"],
    method: "heuristic"
  });
});

test("expandWithLLM falls back to heuristic expansion", async () => {
  const expander = new QueryExpander({ enabled: true });
  const expanded = await expander.expandWithLLM("repo config", "http://localhost:11434");

  assert.deepEqual(expanded, {
    original: "repo config",
    variants: [
      "repo config",
      "repository configuration",
      "repo repository config configuration"
    ],
    method: "heuristic"
  });
});

test("expandWithLLM uses remote variants when available", async () => {
  const expander = new QueryExpander({
    enabled: true,
    model: "qwen2.5",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              variants: ["repository config", "repo settings"]
            })
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
  });

  const expanded = await expander.expandWithLLM("repo config", "http://localhost:11434");

  assert.equal(expanded.method, "llm");
  assert.deepEqual(expanded.variants, [
    "repo config",
    "repository config",
    "repo settings"
  ]);
});
