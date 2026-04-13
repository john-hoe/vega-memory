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

const createStoredMemory = (id: string, overrides: Partial<Memory> = {}): Memory => {
  const { summary = null, ...rest } = overrides;

  return {
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
    ...rest,
    summary
  };
};

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

test("AnalyticsService builds impact and weekly summaries from the shared metrics model", () => {
  const harness = createRepositoryHarness();
  const analyticsService = new AnalyticsService(harness.repository);
  const now = new Date();
  const recentTimestamp = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  try {
    harness.repository.createMemory(
      createStoredMemory("impact-memory-1", {
        created_at: recentTimestamp,
        updated_at: recentTimestamp,
        accessed_at: recentTimestamp,
        access_count: 4
      })
    );
    harness.repository.createMemory(
      createStoredMemory("impact-memory-2", {
        created_at: recentTimestamp,
        updated_at: recentTimestamp,
        accessed_at: recentTimestamp,
        access_count: 2,
        type: "pitfall"
      })
    );
    harness.repository.logPerformance({
      timestamp: recentTimestamp,
      operation: "recall",
      detail: JSON.stringify({
        query: "impact query"
      }),
      latency_ms: 31,
      memory_count: 2,
      result_count: 2,
      avg_similarity: 0.81,
      result_types: ["decision", "pitfall"],
      bm25_result_count: 1
    });

    const impact = analyticsService.getImpactReport({
      days: 7,
      runtimeReadiness: "pass",
      setupSurfaceCoverage: {
        codex: "configured",
        claude: "missing",
        cursor: "partial"
      }
    });
    const weekly = analyticsService.getWeeklySummary({
      days: 7
    });

    assert.equal(impact.new_memories_this_week, 2);
    assert.equal(impact.runtime_readiness, "pass");
    assert.equal(impact.setup_surface_coverage?.codex, "configured");
    assert.equal(impact.top_reused_memories[0]?.id, "impact-memory-1");
    assert.match(impact.conclusion?.headline ?? "", /Vega|runtime|reuse/i);
    assert.equal(Array.isArray(impact.recommended_actions), true);
    assert.equal(typeof impact.top_reused_memories[0]?.explanation, "string");
    assert.equal(weekly.new_memories_this_week, 2);
    assert.equal(weekly.api_calls_total, 1);
    assert.equal(weekly.top_reused_memories_basis, "lifetime_access_count");
    assert.equal(weekly.top_reused_memories[0]?.id, "impact-memory-1");
    assert.equal(weekly.result_type_hits.decision, 1);
    assert.equal(weekly.result_type_hits.pitfall, 1);
    assert.equal(weekly.top_search_queries[0]?.query, "impact query");
    assert.equal(typeof weekly.overview.headline, "string");
    assert.equal(Array.isArray(weekly.key_signals), true);
    assert.equal(Array.isArray(weekly.recommended_actions), true);
  } finally {
    harness.cleanup();
  }
});

test("AnalyticsService weekly top search queries respect the requested window and tenant scope", () => {
  const harness = createRepositoryHarness();
  const analyticsService = new AnalyticsService(harness.repository);
  const tenantService = new TenantService(harness.repository);
  const tenantA = tenantService.createTenant("Tenant A", "pro");
  const tenantB = tenantService.createTenant("Tenant B", "pro");
  const now = new Date();
  const recentTimestamp = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const oldTimestamp = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000).toISOString();

  try {
    harness.repository.logPerformance({
      timestamp: oldTimestamp,
      tenant_id: tenantA.id,
      operation: "recall",
      detail: JSON.stringify({
        query: "old tenant-a query"
      }),
      latency_ms: 20,
      memory_count: 1,
      result_count: 1,
      avg_similarity: 0.7,
      result_types: ["decision"],
      bm25_result_count: 1
    });
    harness.repository.logPerformance({
      timestamp: recentTimestamp,
      tenant_id: tenantA.id,
      operation: "recall",
      detail: JSON.stringify({
        query: "recent tenant-a query"
      }),
      latency_ms: 20,
      memory_count: 1,
      result_count: 1,
      avg_similarity: 0.7,
      result_types: ["decision"],
      bm25_result_count: 1
    });
    harness.repository.logPerformance({
      timestamp: recentTimestamp,
      tenant_id: tenantB.id,
      operation: "recall",
      detail: JSON.stringify({
        query: "recent tenant-b query"
      }),
      latency_ms: 20,
      memory_count: 1,
      result_count: 1,
      avg_similarity: 0.7,
      result_types: ["decision"],
      bm25_result_count: 1
    });

    const weekly = analyticsService.getWeeklySummary({
      tenantId: tenantA.id,
      days: 7
    });

    assert.deepEqual(weekly.top_search_queries, [
      {
        query: "recent tenant-a query",
        count: 1
      }
    ]);
  } finally {
    harness.cleanup();
  }
});

test("Impact and weekly narratives do not claim current-window reuse from lifetime-only accesses", () => {
  const harness = createRepositoryHarness();
  const analyticsService = new AnalyticsService(harness.repository);
  const now = new Date();
  const recentTimestamp = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const oldAccessedAt = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000).toISOString();

  try {
    harness.repository.createMemory(
      createStoredMemory("lifetime-memory", {
        created_at: recentTimestamp,
        updated_at: recentTimestamp,
        accessed_at: oldAccessedAt,
        access_count: 12
      })
    );

    const impact = analyticsService.getImpactReport({
      days: 7,
      runtimeReadiness: "pass",
      setupSurfaceCoverage: {
        codex: "configured"
      }
    });
    const weekly = analyticsService.getWeeklySummary({
      days: 7
    });

    assert.equal(impact.top_reused_memories[0]?.id, "lifetime-memory");
    assert.match(impact.top_reused_memories[0]?.explanation ?? "", /lifetime access count/i);
    assert.equal(impact.conclusion?.status, "needs_attention");
    assert.match(impact.conclusion?.headline ?? "", /reuse has not shown up in this window/i);
    assert.match(weekly.overview.headline, /more than demonstrated reuse/i);
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
