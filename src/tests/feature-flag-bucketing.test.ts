import assert from "node:assert/strict";
import test from "node:test";

import { hashBucket } from "../feature-flags/bucketing.js";

test("hashBucket is deterministic for same input", () => {
  const b1 = hashBucket("user-123", "flag.a");
  const b2 = hashBucket("user-123", "flag.a");
  assert.equal(b1, b2);
  assert.ok(b1 >= 0 && b1 <= 99);
});

test("hashBucket matches the sha256-derived bucket for a known input", () => {
  assert.equal(hashBucket("user-123", "canary-api-ingest-v2"), 37);
});

test("hashBucket changes when the seed or flag changes", () => {
  assert.equal(hashBucket("user-456", "canary-api-ingest-v2"), 95);
  assert.equal(hashBucket("project-alpha", "canary-api-ingest-v2"), 1);
});

test("hashBucket distribution is roughly uniform", () => {
  const counts = new Array(100).fill(0);
  for (let i = 0; i < 1000; i++) {
    const bucket = hashBucket(`seed-${i}`, "flag.dist");
    counts[bucket]++;
  }
  // Every bucket should get at least one hit with 1000 samples
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  assert.ok(minCount > 0, `Expected every bucket to get at least 1 hit, got min=${minCount}`);
  assert.ok(maxCount < 30, `Expected max count < 30, got max=${maxCount}`);
});
