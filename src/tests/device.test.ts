import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getDeviceIdentity,
  resetDeviceIdentityCacheForTests
} from "../core/device.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("generates device identity with valid fields", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-device-"));
  const previousVegaHome = process.env.VEGA_HOME;

  try {
    process.env.VEGA_HOME = tempDir;
    resetDeviceIdentityCacheForTests();

    const identity = getDeviceIdentity();

    assert.match(identity.device_id, UUID_PATTERN);
    assert.equal(typeof identity.device_name, "string");
    assert.ok(identity.device_name.length > 0);
    assert.equal(typeof identity.platform, "string");
    assert.ok(identity.platform.length > 0);
  } finally {
    resetDeviceIdentityCacheForTests();
    process.env.VEGA_HOME = previousVegaHome;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("caches device identity across calls", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-device-cache-"));
  const previousVegaHome = process.env.VEGA_HOME;

  try {
    process.env.VEGA_HOME = tempDir;
    resetDeviceIdentityCacheForTests();

    const first = getDeviceIdentity();
    const second = getDeviceIdentity();

    assert.equal(first.device_id, second.device_id);
  } finally {
    resetDeviceIdentityCacheForTests();
    process.env.VEGA_HOME = previousVegaHome;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("falls back deterministically and warns when device identity cannot be persisted", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-device-unwritable-"));
  const blockedPath = join(tempDir, "blocked-home");
  const previousVegaHome = process.env.VEGA_HOME;
  const warnings: string[] = [];
  const originalWarn = console.warn;

  try {
    writeFileSync(blockedPath, "not-a-directory", "utf8");
    process.env.VEGA_HOME = blockedPath;
    resetDeviceIdentityCacheForTests();
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };

    const first = getDeviceIdentity();
    resetDeviceIdentityCacheForTests();
    const second = getDeviceIdentity();

    assert.equal(first.device_id, second.device_id);
    assert.ok(warnings.some((warning) => warning.includes("failed to persist device identity")));
  } finally {
    console.warn = originalWarn;
    resetDeviceIdentityCacheForTests();
    process.env.VEGA_HOME = previousVegaHome;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
