import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { AnalyticsService } from "../core/analytics.js";
import { BillingService } from "../core/billing.js";
import { TeamService } from "../core/team.js";
import { TenantService } from "../core/tenant.js";
import type { Memory } from "../core/types.js";
import { WhiteLabelConfig } from "../core/whitelabel.js";
import { Repository } from "../db/repository.js";
import { RBACService } from "../security/rbac.js";
import { renderDashboardPage } from "../web/dashboard.js";

const timestamp = "2026-04-05T12:00:00.000Z";

const createStoredMemory = (id: string, overrides: Partial<Memory> = {}): Memory => ({
  id,
  type: "decision",
  project: "vega",
  title: `Memory ${id}`,
  content: `Content for ${id}`,
  embedding: null,
  importance: 0.5,
  source: "explicit",
  tags: ["enterprise"],
  created_at: timestamp,
  updated_at: timestamp,
  accessed_at: timestamp,
  access_count: 0,
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const createRepositoryHarness = (): {
  repository: Repository;
  tempDir: string;
  cleanup(): void;
} => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-enterprise-"));
  const repository = new Repository(join(tempDir, "memory.db"));

  return {
    repository,
    tempDir,
    cleanup(): void {
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
};

test("TenantService.createTenant creates tenant with API key", () => {
  const harness = createRepositoryHarness();
  const tenantService = new TenantService(harness.repository);

  try {
    const tenant = tenantService.createTenant("Acme", "pro");

    assert.equal(tenant.name, "Acme");
    assert.equal(tenant.plan, "pro");
    assert.equal(tenant.active, true);
    assert.match(tenant.api_key, /^vega_[0-9a-f]+$/);
    assert.equal(tenantService.getTenant(tenant.id)?.api_key, tenant.api_key);
  } finally {
    harness.cleanup();
  }
});

test("TenantService.getTenantByApiKey finds tenant", () => {
  const harness = createRepositoryHarness();
  const tenantService = new TenantService(harness.repository);

  try {
    const tenant = tenantService.createTenant("Northwind", "free");
    const found = tenantService.getTenantByApiKey(tenant.api_key);

    assert.ok(found);
    assert.equal(found.id, tenant.id);
    assert.equal(found.name, "Northwind");
  } finally {
    harness.cleanup();
  }
});

test("TenantService.deactivateTenant marks tenant inactive", () => {
  const harness = createRepositoryHarness();
  const tenantService = new TenantService(harness.repository);

  try {
    const tenant = tenantService.createTenant("InactiveCo", "free");

    tenantService.deactivateTenant(tenant.id);

    assert.equal(tenantService.getTenant(tenant.id)?.active, false);
    assert.equal(tenantService.getTenantByApiKey(tenant.api_key), null);
  } finally {
    harness.cleanup();
  }
});

test("RBACService.checkPermission returns true for admin on any action", () => {
  const harness = createRepositoryHarness();
  const teamService = new TeamService(harness.repository);
  const rbacService = new RBACService(harness.repository);

  try {
    const team = teamService.createTeam("Platform", "owner-1");

    assert.equal(rbacService.checkPermission("owner-1", team.id, "store"), true);
    assert.equal(rbacService.checkPermission("owner-1", team.id, "delete"), true);
    assert.equal(rbacService.checkPermission("owner-1", team.id, "admin"), true);
  } finally {
    harness.cleanup();
  }
});

test("RBACService.checkPermission returns false for readonly on store", () => {
  const harness = createRepositoryHarness();
  const teamService = new TeamService(harness.repository);
  const rbacService = new RBACService(harness.repository);

  try {
    const team = teamService.createTeam("Docs", "owner-2");

    teamService.addMember(team.id, "reader-1", "readonly");

    assert.equal(rbacService.checkPermission("reader-1", team.id, "list"), true);
    assert.equal(rbacService.checkPermission("reader-1", team.id, "store"), false);
  } finally {
    harness.cleanup();
  }
});

test("AnalyticsService.getUsageStats returns valid stats", () => {
  const harness = createRepositoryHarness();
  const analyticsService = new AnalyticsService(harness.repository);
  const tenantService = new TenantService(harness.repository);

  try {
    const primaryTenant = tenantService.createTenant("Analytics", "pro");
    const secondaryTenant = tenantService.createTenant("Other", "free");

    harness.repository.createMemory(createStoredMemory("analytics-1"));
    harness.repository.createMemory(
      createStoredMemory("analytics-2", {
        tenant_id: primaryTenant.id,
        type: "insight",
        project: "alpha",
        created_at: "2026-04-05T13:00:00.000Z",
        updated_at: "2026-04-05T13:00:00.000Z",
        accessed_at: "2026-04-05T13:00:00.000Z"
      })
    );
    harness.repository.createMemory(
      createStoredMemory("analytics-archived", {
        tenant_id: primaryTenant.id,
        status: "archived"
      })
    );
    harness.repository.createMemory(
      createStoredMemory("analytics-tenant-1", {
        tenant_id: primaryTenant.id
      })
    );
    harness.repository.createMemory(
      createStoredMemory("analytics-tenant-2", {
        tenant_id: secondaryTenant.id,
        project: "beta"
      })
    );
    harness.repository.logPerformance({
      timestamp: "2026-04-05T10:15:00.000Z",
      tenant_id: primaryTenant.id,
      operation: "store",
      latency_ms: 24,
      memory_count: 2,
      result_count: 1,
      avg_similarity: null,
      result_types: ["decision"],
      bm25_result_count: 0
    });
    harness.repository.logPerformance({
      timestamp: "2026-04-05T10:45:00.000Z",
      tenant_id: primaryTenant.id,
      operation: "recall",
      latency_ms: 36,
      memory_count: 2,
      result_count: 2,
      avg_similarity: 0.72,
      result_types: ["decision", "insight"],
      bm25_result_count: 1
    });
    harness.repository.logPerformance({
      timestamp: "2026-04-05T11:15:00.000Z",
      tenant_id: secondaryTenant.id,
      operation: "store",
      latency_ms: 20,
      memory_count: 1,
      result_count: 1,
      avg_similarity: null,
      result_types: ["decision"],
      bm25_result_count: 0
    });

    const stats = analyticsService.getUsageStats(primaryTenant.id);

    assert.equal(stats.api_calls_total, 2);
    assert.equal(stats.api_calls_by_operation.store, 1);
    assert.equal(stats.api_calls_by_operation.recall, 1);
    assert.equal(stats.memories_total, 2);
    assert.equal(stats.memories_by_type.decision, 1);
    assert.equal(stats.memories_by_type.insight, 1);
    assert.equal(stats.memories_by_project.vega, 1);
    assert.equal(stats.memories_by_project.alpha, 1);
    assert.equal(stats.active_projects, 2);
    assert.equal(stats.peak_hour, "10:00");
    assert.equal(typeof stats.storage_bytes, "number");
    assert.equal(typeof stats.avg_latency_ms, "number");
  } finally {
    harness.cleanup();
  }
});

test("BillingService.checkQuota returns correct limits for free plan", () => {
  const harness = createRepositoryHarness();
  const tenantService = new TenantService(harness.repository);
  const billingService = new BillingService(harness.repository);

  try {
    const tenant = tenantService.createTenant("Starter", "free");
    const otherTenant = tenantService.createTenant("Busy Neighbor", "pro");

    harness.repository.createMemory(
      createStoredMemory("foreign-quota-memory", {
        tenant_id: otherTenant.id
      })
    );
    harness.repository.logPerformance({
      timestamp,
      tenant_id: otherTenant.id,
      operation: "store",
      latency_ms: 12,
      memory_count: 1,
      result_count: 1,
      avg_similarity: null,
      result_types: ["decision"],
      bm25_result_count: 0
    });

    const quota = billingService.checkQuota(tenant.id);

    assert.equal(quota.plan, "free");
    assert.equal(quota.memory_usage, 0);
    assert.equal(quota.memory_limit, 1000);
    assert.equal(quota.api_usage, 0);
    assert.equal(quota.api_limit, 10000);
    assert.equal(quota.over_quota, false);
  } finally {
    harness.cleanup();
  }
});

test("BillingService.isOverQuota returns true when over limit", () => {
  const harness = createRepositoryHarness();
  const tenantService = new TenantService(harness.repository);
  const billingService = new BillingService(harness.repository);

  try {
    const tenant = tenantService.createTenant("Overflow", "free");

    for (let index = 0; index < 1001; index += 1) {
      harness.repository.createMemory(
        createStoredMemory(`quota-${index}`, {
          tenant_id: tenant.id,
          created_at: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
          updated_at: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
          accessed_at: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`
        })
      );
    }

    assert.equal(billingService.isOverQuota(tenant.id), true);
  } finally {
    harness.cleanup();
  }
});

test("WhiteLabelConfig.load returns defaults when no config file", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-whitelabel-"));
  const config = new WhiteLabelConfig(join(tempDir, "whitelabel.json"));

  try {
    assert.deepEqual(config.load(), config.getDefaults());
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("renderDashboardPage does not reprocess white-label values as template tokens", () => {
  const rendered = renderDashboardPage("brand=__VEGA_BRAND_NAME__|css=__VEGA_CUSTOM_CSS__", {
    brandName: "__VEGA_CUSTOM_CSS__",
    logoUrl: null,
    primaryColor: "#48c4b6",
    dashboardTitle: "Dashboard",
    footerText: "Footer",
    customCss: 'body { color: "#fff"; }'
  });

  assert.match(rendered, /brand=__VEGA_CUSTOM_CSS__/);
  assert.match(rendered, /css=<style>body \{ color: "#fff"; \}<\/style>/);
  assert.equal(rendered.includes("brand=<style>"), false);
});
