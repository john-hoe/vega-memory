import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSunsetRegistry } from "../sunset/registry.js";

function createRegistryFile(contents: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "vega-sunset-registry-"));
  const path = join(directory, "sunset-registry.yaml");
  writeFileSync(path, contents, "utf8");
  return { directory, path };
}

function captureConsoleLog<T>(fn: () => T): { result: T; messages: string[] } {
  const originalConsoleLog = console.log;
  const messages: string[] = [];

  console.log = (...args: unknown[]): void => {
    messages.push(args.map((value) => String(value)).join(" "));
  };

  try {
    return {
      result: fn(),
      messages
    };
  } finally {
    console.log = originalConsoleLog;
  }
}

test("loadSunsetRegistry parses a valid minimal time_based entry", () => {
  const { directory, path } = createRegistryFile(`
sunsets:
  - id: legacy-store-route
    type: api_route
    target: POST /memory_store
    deprecated_since: 2026-01-15
    criteria:
      time_based:
        min_days_since_deprecated: 90
    notification:
      changelog: true
      log_level: warn
`);

  try {
    const candidates = loadSunsetRegistry(path);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.id, "legacy-store-route");
    assert.equal(candidates[0]?.criteria.time_based?.min_days_since_deprecated, 90);
    assert.equal(candidates[0]?.criteria.usage_threshold, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadSunsetRegistry parses a valid minimal usage_threshold entry", () => {
  const { directory, path } = createRegistryFile(`
sunsets:
  - id: legacy-search-route
    type: api_route
    target: GET /search
    deprecated_since: 2026-01-15
    criteria:
      usage_threshold:
        metric: vega_api_route_calls_total
        window_days: 30
        max_calls: 10
    notification:
      changelog: false
      log_level: info
`);

  try {
    const candidates = loadSunsetRegistry(path);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.criteria.usage_threshold?.metric, "vega_api_route_calls_total");
    assert.equal(candidates[0]?.criteria.time_based, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadSunsetRegistry parses an entry with both criteria present", () => {
  const { directory, path } = createRegistryFile(`
sunsets:
  - id: legacy-context-route
    type: api_route
    target: POST /context_resolve
    deprecated_since: 2026-01-15
    criteria:
      usage_threshold:
        metric: vega_context_resolve_calls_total
        window_days: 14
        max_calls: 3
      time_based:
        min_days_since_deprecated: 45
    notification:
      changelog: true
      log_level: error
`);

  try {
    const candidates = loadSunsetRegistry(path);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.criteria.usage_threshold?.max_calls, 3);
    assert.equal(candidates[0]?.criteria.time_based?.min_days_since_deprecated, 45);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadSunsetRegistry returns an empty array and warns when both criteria are missing", () => {
  const { directory, path } = createRegistryFile(`
sunsets:
  - id: invalid-missing-criteria
    type: api_route
    target: POST /memory_store
    deprecated_since: 2026-01-15
    criteria:
    notification:
      changelog: true
      log_level: warn
`);

  try {
    const { result, messages } = captureConsoleLog(() => loadSunsetRegistry(path));

    assert.deepEqual(result, []);
    assert.equal(messages.some((message) => message.includes("\"level\":\"warn\"")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadSunsetRegistry returns an empty array and warns when id is invalid", () => {
  const { directory, path } = createRegistryFile(`
sunsets:
  - id: Invalid_ID
    type: api_route
    target: POST /memory_store
    deprecated_since: 2026-01-15
    criteria:
      time_based:
        min_days_since_deprecated: 90
    notification:
      changelog: true
      log_level: warn
`);

  try {
    const { result, messages } = captureConsoleLog(() => loadSunsetRegistry(path));

    assert.deepEqual(result, []);
    assert.equal(messages.some((message) => message.includes("\"level\":\"warn\"")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadSunsetRegistry returns an empty array and warns when deprecated_since is invalid", () => {
  const { directory, path } = createRegistryFile(`
sunsets:
  - id: invalid-date
    type: api_route
    target: POST /memory_store
    deprecated_since: 2026-99-99
    criteria:
      time_based:
        min_days_since_deprecated: 90
    notification:
      changelog: true
      log_level: warn
`);

  try {
    const { result, messages } = captureConsoleLog(() => loadSunsetRegistry(path));

    assert.deepEqual(result, []);
    assert.equal(messages.some((message) => message.includes("\"level\":\"warn\"")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadSunsetRegistry returns an empty array and warns when notification log level is invalid", () => {
  const { directory, path } = createRegistryFile(`
sunsets:
  - id: invalid-log-level
    type: api_route
    target: POST /memory_store
    deprecated_since: 2026-01-15
    criteria:
      time_based:
        min_days_since_deprecated: 90
    notification:
      changelog: true
      log_level: fatal
`);

  try {
    const { result, messages } = captureConsoleLog(() => loadSunsetRegistry(path));

    assert.deepEqual(result, []);
    assert.equal(messages.some((message) => message.includes("\"level\":\"warn\"")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadSunsetRegistry returns an empty array and warns when the file is missing", () => {
  const directory = mkdtempSync(join(tmpdir(), "vega-sunset-registry-missing-"));
  const path = join(directory, "does-not-exist.yaml");

  try {
    const { result, messages } = captureConsoleLog(() => loadSunsetRegistry(path));

    assert.deepEqual(result, []);
    assert.equal(messages.some((message) => message.includes("\"level\":\"warn\"")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
