import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectFeatureFlagRegistry, loadFeatureFlagRegistry } from "../feature-flags/registry.js";

test("loadFeatureFlagRegistry loads valid registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-reg-"));
  const path = join(dir, "flags.yaml");
  writeFileSync(
    path,
    `flags:
  - id: canary-test
    description: Test flag
    variants:
      on: true
      off: false
    default: "off"
    matchers:
      surfaces: "*"
      intents: ["ingest"]
      traffic_percent: 10
`
  );
  const flags = loadFeatureFlagRegistry(path);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, "canary-test");
  assert.equal(flags[0].description, "Test flag");
  assert.deepEqual(flags[0].variants, { on: true, off: false });
  assert.equal(flags[0].default, "off");
  assert.deepEqual(flags[0].matchers.surfaces, "*");
  assert.deepEqual(flags[0].matchers.intents, ["ingest"]);
  assert.equal(flags[0].matchers.traffic_percent, 10);
});

test("loadFeatureFlagRegistry returns empty array for schema error", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-reg-"));
  const path = join(dir, "flags.yaml");
  writeFileSync(path, "flags:\n  - id: 123\n    description: Missing required fields\n");
  const flags = loadFeatureFlagRegistry(path);
  assert.deepEqual(flags, []);
});

test("loadFeatureFlagRegistry returns empty array for missing file", () => {
  const flags = loadFeatureFlagRegistry("/nonexistent/path/flags.yaml");
  assert.deepEqual(flags, []);
});

test("loadFeatureFlagRegistry expands env variables", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-reg-"));
  const path = join(dir, "flags.yaml");
  writeFileSync(
    path,
    `flags:
  - id: canary-env
    description: \${DESC}
    variants:
      on: 1
      off: 0
    default: "off"
    matchers:
      surfaces: ["api"]
      intents: "*"
      traffic_percent: 50
`
  );
  const flags = loadFeatureFlagRegistry(path, { env: { DESC: "Expanded desc" } });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].description, "Expanded desc");
});

test("inspectFeatureFlagRegistry reports parse_error for an invalid root key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ff-reg-"));
  const path = join(dir, "flags.yaml");
  writeFileSync(path, "wrong_root: []\n");
  const result = inspectFeatureFlagRegistry(path);
  assert.equal(result.flags.length, 0);
  assert.equal(result.degraded, "parse_error");
});
