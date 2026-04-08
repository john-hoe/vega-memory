import assert from "node:assert/strict";
import test from "node:test";

import { PlanManager } from "../billing/plans.js";
import { UsageMeter } from "../billing/metering.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";

test("PlanManager returns the requested catalog and plan lookups", () => {
  const manager = new PlanManager();
  const freePlan = manager.getPlan("free");
  const enterprisePlan = manager.getPlan("enterprise");

  assert.deepEqual(
    manager.listPlans().map((plan) => plan.id),
    ["free", "pro", "enterprise"]
  );
  assert.equal(freePlan?.name, "Free");
  assert.equal(freePlan?.memoriesLimit, 100);
  assert.equal(freePlan?.storageLimitMB, 10);
  assert.equal(enterprisePlan?.priceMonthly, null);
  assert.equal(enterprisePlan?.memoriesLimit, -1);
  assert.equal(manager.getPlan("missing"), undefined);
});

test("PlanManager upgrade and downgrade rules follow tier ordering", () => {
  const manager = new PlanManager();

  assert.equal(manager.canUpgrade("free", "pro"), true);
  assert.equal(manager.canUpgrade("pro", "enterprise"), true);
  assert.equal(manager.canUpgrade("enterprise", "pro"), false);
  assert.equal(manager.canUpgrade("free", "free"), false);

  assert.equal(manager.canDowngrade("enterprise", "pro"), true);
  assert.equal(manager.canDowngrade("pro", "free"), true);
  assert.equal(manager.canDowngrade("free", "pro"), false);
  assert.equal(manager.canDowngrade("pro", "pro"), false);
});

test("PlanManager exposes feature limits for each plan", () => {
  const manager = new PlanManager();

  assert.deepEqual(manager.getFeatureLimits("free"), {
    memories: 100,
    users: 1,
    storageMB: 10,
    apiRateLimit: 10_000,
    wikiPages: 10,
    customBranding: false
  });
  assert.deepEqual(manager.getFeatureLimits("pro"), {
    memories: 10_000,
    users: 10,
    storageMB: 1_024,
    apiRateLimit: 100_000,
    wikiPages: 1_000,
    customBranding: false
  });
  assert.deepEqual(manager.getFeatureLimits("enterprise"), {
    memories: -1,
    users: -1,
    storageMB: -1,
    apiRateLimit: -1,
    wikiPages: -1,
    customBranding: true
  });
});

test("UsageMeter records usage, summarizes metrics, and checks plan limits", async () => {
  const adapter = new SQLiteAdapter(":memory:");
  const meter = new UsageMeter(adapter);

  try {
    await meter.recordUsage("tenant-1", "memories", 40);
    await meter.recordUsage("tenant-1", "memories", 70);
    await meter.recordUsage("tenant-1", "users", 2);
    await meter.recordUsage("tenant-1", "storageMB", 6);
    await meter.recordUsage("tenant-2", "memories", 999);

    assert.equal(await meter.getUsage("tenant-1", "memories", new Date(0)), 110);
    assert.deepEqual(await meter.getUsageSummary("tenant-1"), {
      memories: 110,
      storageMB: 6,
      users: 2
    });

    assert.deepEqual(await meter.checkLimit("tenant-1", "memories", "free"), {
      allowed: false,
      current: 110,
      limit: 100
    });
    assert.deepEqual(await meter.checkLimit("tenant-1", "users", "pro"), {
      allowed: true,
      current: 2,
      limit: 10
    });
    assert.deepEqual(await meter.checkLimit("tenant-1", "memories", "enterprise"), {
      allowed: true,
      current: 110,
      limit: -1
    });
  } finally {
    adapter.close();
  }
});
