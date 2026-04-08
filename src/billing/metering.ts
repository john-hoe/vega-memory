import type { DatabaseAdapter } from "../db/adapter.js";
import { PlanManager } from "./plans.js";

interface UsageTotalRow {
  total: number | null;
}

interface UsageSummaryRow {
  metric: string | null;
  total: number | null;
}

const CURRENT_PERIOD_START = new Date(0);

const normalizeTenantId = (tenantId: string): string => {
  const normalized = tenantId.trim();

  if (normalized.length === 0) {
    throw new Error("tenantId is required");
  }

  return normalized;
};

const normalizeMetric = (metric: string): string => {
  const normalized = metric.trim();

  if (normalized.length === 0) {
    throw new Error("metric is required");
  }

  return normalized;
};

const normalizeAmount = (amount: number): number => {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`amount must be a finite non-negative number: ${amount}`);
  }

  return amount;
};

const resolveMetricLimit = (
  metric: string,
  planManager: PlanManager,
  planId: string
): number => {
  const limits = planManager.getFeatureLimits(planId);

  switch (metric) {
    case "memories":
      return limits.memories;
    case "users":
      return limits.users;
    case "storage":
    case "storageMB":
      return limits.storageMB;
    case "api":
    case "api_calls":
    case "apiRateLimit":
      return limits.apiRateLimit;
    case "wiki":
    case "wikiPages":
    case "wiki_pages":
      return limits.wikiPages;
    default:
      throw new Error(`Unsupported usage metric: ${metric}`);
  }
};

export class UsageMeter {
  private readonly planManager = new PlanManager();

  constructor(private readonly db: DatabaseAdapter) {}

  async recordUsage(tenantId: string, metric: string, amount: number): Promise<void> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const normalizedMetric = normalizeMetric(metric);
    const normalizedAmount = normalizeAmount(amount);
    const recordedAt = new Date().toISOString();

    this.db.run(
      `INSERT INTO usage_log (
         tenant_id,
         month,
         updated_at,
         metric,
         amount,
         recorded_at
       )
       VALUES (?, ?, ?, ?, ?, ?)`,
      normalizedTenantId,
      "",
      recordedAt,
      normalizedMetric,
      normalizedAmount,
      recordedAt
    );
  }

  async getUsage(tenantId: string, metric: string, since: Date): Promise<number> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const normalizedMetric = normalizeMetric(metric);
    const row = this.db.get<UsageTotalRow>(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM usage_log
       WHERE tenant_id = ?
         AND metric = ?
         AND recorded_at >= ?`,
      normalizedTenantId,
      normalizedMetric,
      since.toISOString()
    );

    return row?.total ?? 0;
  }

  async checkLimit(
    tenantId: string,
    metric: string,
    planId: string
  ): Promise<{ allowed: boolean; current: number; limit: number }> {
    const normalizedMetric = normalizeMetric(metric);
    const current = await this.getUsage(tenantId, normalizedMetric, CURRENT_PERIOD_START);
    const limit = resolveMetricLimit(normalizedMetric, this.planManager, planId);

    return {
      allowed: limit < 0 || current <= limit,
      current,
      limit
    };
  }

  async getUsageSummary(tenantId: string): Promise<Record<string, number>> {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const rows = this.db.all<UsageSummaryRow>(
      `SELECT metric, COALESCE(SUM(amount), 0) AS total
       FROM usage_log
       WHERE tenant_id = ?
         AND metric IS NOT NULL
         AND metric != ''
       GROUP BY metric
       ORDER BY metric ASC`,
      normalizedTenantId
    );

    return rows.reduce<Record<string, number>>((summary, row) => {
      if (row.metric !== null) {
        summary[row.metric] = row.total ?? 0;
      }

      return summary;
    }, {});
  }
}
