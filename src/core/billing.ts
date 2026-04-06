import type { BillingUsage, QuotaStatus, Tenant, TenantPlan } from "./types.js";
import { getDatabaseSizeBytes } from "./health.js";
import { getPlanMemoryLimit, TenantService } from "./tenant.js";
import { Repository } from "../db/repository.js";

interface TableColumnRow {
  name: string;
}

interface CountRow {
  total: number | null;
}

interface UsageLogRow {
  id: number;
}

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const API_REQUEST_OPERATION_PATTERN = "% /api/%";

const PLAN_API_LIMITS: Record<TenantPlan, number> = {
  free: 10_000,
  pro: 100_000,
  enterprise: -1
};

const getCurrentMonth = (): string => new Date().toISOString().slice(0, 7);

const getMonthRange = (month: string): { start: string; end: string } => {
  if (!MONTH_PATTERN.test(month)) {
    throw new Error(`Invalid month: ${month}`);
  }

  const year = Number.parseInt(month.slice(0, 4), 10);
  const monthIndex = Number.parseInt(month.slice(5, 7), 10) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`Invalid month: ${month}`);
  }

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
};

export class BillingService {
  private readonly tenantService: TenantService;

  constructor(private readonly repository: Repository) {
    this.tenantService = new TenantService(repository);
  }

  private hasColumn(tableName: string, columnName: string): boolean {
    const columns = this.repository.db
      .prepare<[], TableColumnRow>(`PRAGMA table_info(${tableName})`)
      .all();

    return columns.some((column) => column.name === columnName);
  }

  private requireTenant(tenantId: string): Tenant {
    const tenant = this.tenantService.getTenant(tenantId);

    if (tenant === null) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }

    return tenant;
  }

  private countStoredMemoriesForMonth(tenantId: string, month: string): number {
    const { start, end } = getMonthRange(month);
    const clauses = ["created_at >= ?", "created_at < ?"];
    const params: unknown[] = [start, end];

    if (this.hasColumn("memories", "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }

    return (
      this.repository.db
        .prepare<unknown[], CountRow>(
          `SELECT COUNT(*) AS total
           FROM memories
           WHERE ${clauses.join(" AND ")}`
        )
        .get(...params)?.total ?? 0
    );
  }

  private countApiCallsForMonth(tenantId: string, month: string): number {
    const { start, end } = getMonthRange(month);
    const clauses = ["timestamp >= ?", "timestamp < ?", "operation LIKE ?"];
    const params: unknown[] = [start, end, API_REQUEST_OPERATION_PATTERN];

    if (this.hasColumn("performance_log", "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }

    return (
      this.repository.db
        .prepare<unknown[], CountRow>(
          `SELECT COUNT(*) AS total
           FROM performance_log
           WHERE ${clauses.join(" AND ")}`
        )
        .get(...params)?.total ?? 0
    );
  }

  private countActiveMemories(tenantId: string): number {
    const clauses = ["status = 'active'"];
    const params: unknown[] = [];

    if (this.hasColumn("memories", "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }

    return (
      this.repository.db
        .prepare<unknown[], CountRow>(
          `SELECT COUNT(*) AS total
           FROM memories
           WHERE ${clauses.join(" AND ")}`
        )
        .get(...params)?.total ?? 0
    );
  }

  private syncUsageLog(usage: BillingUsage): void {
    const existing = this.repository.db
      .prepare<[string, string], UsageLogRow>(
        `SELECT id
         FROM usage_log
         WHERE tenant_id = ? AND month = ?`
      )
      .get(usage.tenant_id, usage.month);
    const updatedAt = new Date().toISOString();

    if (existing) {
      this.repository.db
        .prepare<[number, number, number, string, number]>(
          `UPDATE usage_log
           SET memory_count = ?, api_calls = ?, storage_bytes = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(usage.memory_count, usage.api_calls, usage.storage_bytes, updatedAt, existing.id);
      return;
    }

    this.repository.db
      .prepare<[string, string, number, number, number, string]>(
        `INSERT INTO usage_log (
           tenant_id,
           month,
           memory_count,
           api_calls,
           storage_bytes,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        usage.tenant_id,
        usage.month,
        usage.memory_count,
        usage.api_calls,
        usage.storage_bytes,
        updatedAt
      );
  }

  getUsageForBilling(tenantId: string, month: string): BillingUsage {
    this.requireTenant(tenantId);

    const usage: BillingUsage = {
      tenant_id: tenantId,
      month,
      memory_count: this.countStoredMemoriesForMonth(tenantId, month),
      api_calls: this.countApiCallsForMonth(tenantId, month),
      storage_bytes: getDatabaseSizeBytes(this.repository.db.name)
    };

    this.syncUsageLog(usage);

    return usage;
  }

  checkQuota(tenantId: string): QuotaStatus {
    const tenant = this.requireTenant(tenantId);
    const usage = this.getUsageForBilling(tenantId, getCurrentMonth());
    const memoryLimit =
      tenant.plan === "enterprise" ? getPlanMemoryLimit("enterprise") : tenant.memory_limit;
    const apiLimit = PLAN_API_LIMITS[tenant.plan];
    const memoryUsage = this.countActiveMemories(tenantId);
    const overQuota =
      (memoryLimit >= 0 && memoryUsage > memoryLimit) || (apiLimit >= 0 && usage.api_calls > apiLimit);

    return {
      plan: tenant.plan,
      memory_usage: memoryUsage,
      memory_limit: memoryLimit,
      api_usage: usage.api_calls,
      api_limit: apiLimit,
      over_quota: overQuota
    };
  }

  isOverQuota(tenantId: string): boolean {
    return this.checkQuota(tenantId).over_quota;
  }
}
