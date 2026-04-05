import { randomBytes, randomUUID } from "node:crypto";

import type { Tenant, TenantPlan } from "./types.js";
import { Repository } from "../db/repository.js";

interface TenantRow {
  id: string;
  name: string;
  plan: TenantPlan;
  api_key: string;
  active: number;
  created_at: string;
  memory_limit: number;
  updated_at: string;
}

export const TENANT_PLANS = ["free", "pro", "enterprise"] as const satisfies readonly TenantPlan[];

export const getPlanMemoryLimit = (plan: TenantPlan): number => {
  switch (plan) {
    case "free":
      return 1_000;
    case "pro":
      return 10_000;
    case "enterprise":
      return -1;
  }
};

export const isTenantPlan = (value: string): value is TenantPlan =>
  TENANT_PLANS.includes(value as TenantPlan);

const now = (): string => new Date().toISOString();

const generateApiKey = (): string => `vega_${randomBytes(24).toString("hex")}`;

const mapTenant = (row: TenantRow): Tenant => ({
  ...row,
  active: row.active === 1
});

export class TenantService {
  constructor(private readonly repository: Repository) {}

  createTenant(name: string, plan: TenantPlan): Tenant {
    const normalizedName = name.trim();

    if (normalizedName.length === 0) {
      throw new Error("Tenant name is required");
    }

    if (!isTenantPlan(plan)) {
      throw new Error(`Unsupported tenant plan: ${plan}`);
    }

    const timestamp = now();
    const tenant: Tenant = {
      id: randomUUID(),
      name: normalizedName,
      plan,
      api_key: generateApiKey(),
      active: true,
      created_at: timestamp,
      memory_limit: getPlanMemoryLimit(plan),
      updated_at: timestamp
    };

    this.repository.db
      .prepare<[string, string, TenantPlan, string, number, string, number, string]>(
        `INSERT INTO tenants (
           id,
           name,
           plan,
           api_key,
           active,
           created_at,
           memory_limit,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        tenant.id,
        tenant.name,
        tenant.plan,
        tenant.api_key,
        tenant.active ? 1 : 0,
        tenant.created_at,
        tenant.memory_limit,
        tenant.updated_at
      );

    return tenant;
  }

  getTenant(id: string): Tenant | null {
    const row = this.repository.db
      .prepare<[string], TenantRow>(
        `SELECT id, name, plan, api_key, active, created_at, memory_limit, updated_at
         FROM tenants
         WHERE id = ?`
      )
      .get(id);

    return row ? mapTenant(row) : null;
  }

  getTenantByApiKey(apiKey: string): Tenant | null {
    const row = this.repository.db
      .prepare<[string], TenantRow>(
        `SELECT id, name, plan, api_key, active, created_at, memory_limit, updated_at
         FROM tenants
         WHERE api_key = ? AND active = 1`
      )
      .get(apiKey);

    return row ? mapTenant(row) : null;
  }

  listTenants(): Tenant[] {
    const rows = this.repository.db
      .prepare<[], TenantRow>(
        `SELECT id, name, plan, api_key, active, created_at, memory_limit, updated_at
         FROM tenants
         ORDER BY created_at ASC, name ASC`
      )
      .all();

    return rows.map(mapTenant);
  }

  updatePlan(tenantId: string, plan: string): void {
    if (!isTenantPlan(plan)) {
      throw new Error(`Unsupported tenant plan: ${plan}`);
    }

    const result = this.repository.db
      .prepare<[TenantPlan, number, string, string]>(
        `UPDATE tenants
         SET plan = ?, memory_limit = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(plan, getPlanMemoryLimit(plan), now(), tenantId);

    if (result.changes === 0) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }
  }

  deactivateTenant(tenantId: string): void {
    const result = this.repository.db
      .prepare<[string, string]>(
        `UPDATE tenants
         SET active = 0, updated_at = ?
         WHERE id = ?`
      )
      .run(now(), tenantId);

    if (result.changes === 0) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }
  }
}
