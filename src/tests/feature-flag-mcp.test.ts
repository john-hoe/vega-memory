import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { createFlagHitMetricsCollector } from "../feature-flags/metrics.js";
import {
  createEvaluateFlagMcpTool,
  createFlagMetricsMcpTool,
  createListFlagsMcpTool,
  evaluateFlagHandler,
  flagMetricsHandler,
  listFlagsHandler
} from "../feature-flags/mcp.js";

test("evaluateFlagHandler returns variant and hit count for a known flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-mcp-"));
  const path = join(dir, "flags.yaml");
  const db = new SQLiteAdapter(":memory:");
  const metrics = createFlagHitMetricsCollector();

  try {
    writeFileSync(
      path,
      `flags:
  - id: canary-mcp
    description: MCP test
    variants:
      on: 1
      off: 0
    default: "off"
    matchers:
      surfaces: "*"
      intents: "*"
      traffic_percent: 100
`
    );

    const result = evaluateFlagHandler(db, path, metrics, {
      flag_id: "canary-mcp",
      context: { surface: "codex", intent: "ingest" }
    });
    assert.equal(result.variant, "on");
    assert.equal(result.schema_version, "1.0");
    assert.equal(result.hit_count, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateFlagHandler returns degraded registry_missing when the registry is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-mcp-missing-"));
  const path = join(dir, "missing.yaml");
  const db = new SQLiteAdapter(":memory:");

  try {
    const result = evaluateFlagHandler(db, path, undefined, { flag_id: "canary.missing" });
    assert.equal(result.variant, "off");
    assert.equal(result.reason, "registry_missing");
    assert.equal(result.degraded, "registry_missing");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateFlagHandler never throws on invalid input", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const result = evaluateFlagHandler(db, "/unused/flags.yaml", undefined, {});
    assert.equal(result.variant, "off");
    assert.equal(result.reason, "invalid_request");
    assert.equal(result.degraded, "invalid_request");
  } finally {
    db.close();
  }
});

test("tool wrapper returns off for a missing flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-mcp-"));
  const path = join(dir, "flags.yaml");
  const db = new SQLiteAdapter(":memory:");

  try {
    writeFileSync(path, "flags: []");
    const handler = createEvaluateFlagMcpTool(db, path, undefined);
    const result = await handler.invoke({ flag_id: "canary.missing" });
    assert.equal(result.variant, "off");
    assert.equal(result.reason, "flag_not_found");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listFlagsHandler returns registry contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-mcp-"));
  const path = join(dir, "flags.yaml");
  const db = new SQLiteAdapter(":memory:");

  try {
    writeFileSync(
      path,
      `flags:
  - id: canary-list
    description: List test
    variants:
      on: 1
      off: 0
    default: "off"
    matchers:
      surfaces: ["api"]
      intents: "*"
      traffic_percent: 10
`
    );
    const result = listFlagsHandler(db, path);
    assert.equal(result.flags.length, 1);
    assert.equal(result.flags[0].id, "canary-list");
    assert.equal(result.degraded, undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool list wrapper returns parse_error for invalid registry yaml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-mcp-invalid-"));
  const path = join(dir, "flags.yaml");
  const db = new SQLiteAdapter(":memory:");

  try {
    writeFileSync(path, "not_flags:\n  - nope: true\n");
    const handler = createListFlagsMcpTool(db, path);
    const result = await handler.invoke({});
    assert.equal(result.flags.length, 0);
    assert.equal(result.degraded, "parse_error");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flagMetricsHandler returns snapshot", () => {
  const metrics = createFlagHitMetricsCollector();
  metrics.record("flag.a", "on", "traffic_100");
  metrics.record("flag.a", "off", "matcher_miss");
  const result = flagMetricsHandler(metrics);
  assert.equal(result.snapshot["flag.a"].on_count, 1);
  assert.equal(result.snapshot["flag.a"].off_count, 1);
});

test("metrics handler returns empty snapshot when metrics undefined", async () => {
  const handler = createFlagMetricsMcpTool(undefined);
  const result = await handler.invoke({});
  assert.deepEqual(result.snapshot, {});
});
