Task 53-57: Phase 8 — Enterprise (all 5 tasks).

Read AGENTS.md for rules. Read ALL src/ files to understand the current codebase, especially src/core/team.ts, src/db/schema.ts, src/api/auth.ts, src/api/routes.ts, src/config.ts.

## Task 53: Multi-Tenant SaaS
File: src/core/tenant.ts

Export class TenantService:
  - constructor(repository: Repository)
  - createTenant(name: string, plan: 'free'|'pro'|'enterprise'): Tenant
    Insert into tenants table, generate API key for tenant
  - getTenant(id: string): Tenant | null
  - getTenantByApiKey(apiKey: string): Tenant | null
  - listTenants(): Tenant[]
  - updatePlan(tenantId: string, plan: string): void
  - deactivateTenant(tenantId: string): void

Add to schema.ts:
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    api_key TEXT UNIQUE NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    memory_limit INTEGER NOT NULL DEFAULT 1000,
    updated_at TEXT NOT NULL
  )

Tenant type in types.ts:
  { id, name, plan, api_key, active, created_at, memory_limit, updated_at }

Add CLI: vega tenant create <name> [--plan pro]
         vega tenant list
         vega tenant deactivate <id>

## Task 54: SSO + RBAC
File: src/security/rbac.ts

Export class RBACService:
  - constructor(repository: Repository)
  - Roles: 'admin' | 'member' | 'readonly'
  - Permissions matrix:
    admin: all operations (store, recall, list, update, delete, compact, session, admin)
    member: store, recall, list, update, session
    readonly: recall, list
  - checkPermission(userId: string, teamId: string, action: string): boolean
    Look up user's role in team_members, check against permissions matrix
  - requirePermission(userId: string, teamId: string, action: string): void
    Throw if not permitted

File: src/security/sso.ts
Export class SSOProvider:
  Placeholder for future SSO integration:
  - constructor(config)
  - async validateToken(token: string): Promise<SSOUser | null>
    Placeholder: return null (no SSO configured)
  - isConfigured(): boolean
    Return false (placeholder)

SSOUser = { id: string, email: string, name: string, provider: string }

## Task 55: Usage Analytics Dashboard
File: src/core/analytics.ts

Export class AnalyticsService:
  - constructor(repository: Repository)
  - getUsageStats(tenantId?: string, since?: string): UsageStats
    Query performance_log and memories table:
    - api_calls_total: count of performance_log entries
    - api_calls_by_operation: group by operation
    - memories_total: count of active memories
    - memories_by_type: group by type
    - memories_by_project: group by project
    - storage_bytes: db file size
    - avg_latency_ms: from performance_log
    - active_projects: distinct project count
    - peak_hour: hour with most API calls
  - getGrowthTrend(days: number): GrowthPoint[]
    Daily memory count over last N days
  - getTopSearchQueries(limit: number): {query: string, count: number}[]
    From performance_log detail field (if stored)

UsageStats type in types.ts
GrowthPoint = { date: string, count: number }

Add API endpoint: GET /api/analytics?since=2026-01-01
Add CLI: vega analytics [--since 2026-01-01] [--json]

## Task 56: Billing Integration (Foundation)
File: src/core/billing.ts

Export class BillingService:
  - constructor(repository: Repository)
  - getUsageForBilling(tenantId: string, month: string): BillingUsage
    Count: memories stored, API calls, storage bytes for the month
  - checkQuota(tenantId: string): QuotaStatus
    Compare current usage against tenant's plan limits:
    free: 1000 memories, 10000 API calls/month
    pro: 10000 memories, 100000 API calls/month
    enterprise: unlimited
  - isOverQuota(tenantId: string): boolean

BillingUsage = { tenant_id, month, memory_count, api_calls, storage_bytes }
QuotaStatus = { plan, memory_usage, memory_limit, api_usage, api_limit, over_quota }

Add to schema.ts:
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT,
    month TEXT NOT NULL,
    memory_count INTEGER DEFAULT 0,
    api_calls INTEGER DEFAULT 0,
    storage_bytes INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL
  )

## Task 57: White-Label Deployment
File: src/core/whitelabel.ts

Export class WhiteLabelConfig:
  - constructor(configPath?: string)
  - load(): WhiteLabelSettings
    Read from data/whitelabel.json if exists, otherwise return defaults
  - save(settings: WhiteLabelSettings): void
  - getDefaults(): WhiteLabelSettings

WhiteLabelSettings = {
  brandName: string (default "Vega Memory"),
  logoUrl: string | null,
  primaryColor: string (default "#48c4b6"),
  dashboardTitle: string (default "Vega Memory Dashboard"),
  footerText: string (default "Powered by Vega Memory System"),
  customCss: string | null
}

Integrate into web dashboard:
  - src/web/dashboard.ts: load WhiteLabelConfig, pass settings to template
  - src/web/public/index.html: use brandName/primaryColor/footerText from config (inject via script tag or data attributes)

Add CLI: vega whitelabel [--brand-name "MyBrand"] [--primary-color "#ff0000"]

## Tests:
File: src/tests/enterprise.test.ts
- Test: TenantService.createTenant creates tenant with API key
- Test: TenantService.getTenantByApiKey finds tenant
- Test: TenantService.deactivateTenant marks tenant inactive
- Test: RBACService.checkPermission returns true for admin on any action
- Test: RBACService.checkPermission returns false for readonly on store
- Test: AnalyticsService.getUsageStats returns valid stats
- Test: BillingService.checkQuota returns correct limits for free plan
- Test: BillingService.isOverQuota returns true when over limit
- Test: WhiteLabelConfig.load returns defaults when no config file

After all:
  rm -rf dist && npx tsc
  node --test dist/tests/enterprise.test.js
  node --test dist/tests/*.test.js

Then commit:
  git add -A && git commit -m "feat: Phase 8 — multi-tenant, RBAC, analytics, billing, white-label"
  git tag v1.0.0
  git push origin main --tags
