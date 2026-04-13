import type {
  GrowthPoint,
  ImpactConclusion,
  ImpactMemorySummary,
  ImpactReport,
  MemoryType,
  RecommendedAction,
  RuntimeReadinessDetail,
  UsageStats,
  WeeklyOverview,
  WeeklySummary
} from "./types.js";
import { getDatabaseSizeBytes } from "./health.js";
import { Repository } from "../db/repository.js";

interface TableColumnRow {
  name: string;
}

interface CountRow {
  total: number | null;
}

interface NamedCountRow {
  name: string | null;
  total: number;
}

interface PeakHourRow {
  hour: string | null;
  total: number;
}

interface DateCountRow {
  date: string;
  total: number;
}

interface DetailRow {
  detail: string | null;
}

interface ImpactMemoryRow {
  id: string;
  title: string;
  project: string;
  type: MemoryType;
  access_count: number;
  updated_at: string;
  accessed_at: string | null;
}

interface ResultTypesRow {
  result_types: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const formatDate = (value: Date): string => value.toISOString().slice(0, 10);

const parseJsonArray = (value: string): unknown[] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const toWindowStart = (days: number): string => {
  const startDate = new Date();
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() - days + 1);
  return startDate.toISOString();
};

const normalizeSince = (since: string | undefined): string | undefined => {
  if (since === undefined) {
    return undefined;
  }

  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid since value: ${since}`);
  }

  return parsed.toISOString();
};

const normalizeQuery = (value: string): string | null => {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const formatShortDate = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatDate(parsed);
};

const extractSearchQuery = (detail: string | null): string | null => {
  if (detail === null) {
    return null;
  }

  const normalized = normalizeQuery(detail);
  if (normalized === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized) as unknown;

    if (typeof parsed === "string") {
      return normalizeQuery(parsed);
    }

    if (isRecord(parsed) && typeof parsed.query === "string") {
      return normalizeQuery(parsed.query);
    }

    if (isRecord(parsed) && isRecord(parsed.input) && typeof parsed.input.query === "string") {
      return normalizeQuery(parsed.input.query);
    }
  } catch {}

  return normalized;
};

export class AnalyticsService {
  constructor(private readonly repository: Repository) {}

  private hasColumn(tableName: string, columnName: string): boolean {
    const columns = this.repository.db
      .prepare<[], TableColumnRow>(`PRAGMA table_info(${tableName})`)
      .all();

    return columns.some((column) => column.name === columnName);
  }

  private buildPerformanceWhere(tenantId?: string, since?: string): {
    where: string;
    params: unknown[];
  } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const normalizedSince = normalizeSince(since);

    if (normalizedSince !== undefined) {
      clauses.push("timestamp >= ?");
      params.push(normalizedSince);
    }

    if (tenantId !== undefined && this.hasColumn("performance_log", "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }

    return {
      where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      params
    };
  }

  private buildMemoryWhere(tenantId?: string, since?: string): {
    where: string;
    params: unknown[];
  } {
    const clauses = ["status = 'active'"];
    const params: unknown[] = [];
    const normalizedSince = normalizeSince(since);

    if (normalizedSince !== undefined) {
      clauses.push("created_at >= ?");
      params.push(normalizedSince);
    }

    if (tenantId !== undefined && this.hasColumn("memories", "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }

    return {
      where: `WHERE ${clauses.join(" AND ")}`,
      params
    };
  }

  getUsageStats(tenantId?: string, since?: string): UsageStats {
    const performanceScope = this.buildPerformanceWhere(tenantId, since);
    const memoryScope = this.buildMemoryWhere(tenantId, since);

    const apiCallsTotal =
      this.repository.db
        .prepare<unknown[], CountRow>(
          `SELECT COUNT(*) AS total
           FROM performance_log
           ${performanceScope.where}`
        )
        .get(...performanceScope.params)?.total ?? 0;
    const apiCallsByOperationRows = this.repository.db
      .prepare<unknown[], NamedCountRow>(
        `SELECT operation AS name, COUNT(*) AS total
         FROM performance_log
         ${performanceScope.where}
         GROUP BY operation
         ORDER BY total DESC, operation ASC`
      )
      .all(...performanceScope.params);
    const memoriesTotal =
      this.repository.db
        .prepare<unknown[], CountRow>(
          `SELECT COUNT(*) AS total
           FROM memories
           ${memoryScope.where}`
        )
        .get(...memoryScope.params)?.total ?? 0;
    const memoriesByTypeRows = this.repository.db
      .prepare<unknown[], NamedCountRow>(
        `SELECT type AS name, COUNT(*) AS total
         FROM memories
         ${memoryScope.where}
         GROUP BY type
         ORDER BY total DESC, type ASC`
      )
      .all(...memoryScope.params);
    const memoriesByProjectRows = this.repository.db
      .prepare<unknown[], NamedCountRow>(
        `SELECT project AS name, COUNT(*) AS total
         FROM memories
         ${memoryScope.where}
         GROUP BY project
         ORDER BY total DESC, project ASC`
      )
      .all(...memoryScope.params);
    const avgLatency =
      this.repository.db
        .prepare<unknown[], CountRow>(
          `SELECT AVG(latency_ms) AS total
           FROM performance_log
           ${performanceScope.where}`
        )
        .get(...performanceScope.params)?.total ?? 0;
    const activeProjects =
      this.repository.db
        .prepare<unknown[], CountRow>(
          `SELECT COUNT(DISTINCT project) AS total
           FROM memories
           ${memoryScope.where}`
        )
        .get(...memoryScope.params)?.total ?? 0;
    const peakHourRow = this.repository.db
      .prepare<unknown[], PeakHourRow>(
        `SELECT substr(timestamp, 12, 2) AS hour, COUNT(*) AS total
         FROM performance_log
         ${performanceScope.where}
         GROUP BY hour
         ORDER BY total DESC, hour ASC
         LIMIT 1`
      )
      .get(...performanceScope.params);

    return {
      api_calls_total: apiCallsTotal,
      api_calls_by_operation: apiCallsByOperationRows.reduce<Record<string, number>>((grouped, row) => {
        if (row.name !== null) {
          grouped[row.name] = row.total;
        }

        return grouped;
      }, {}),
      memories_total: memoriesTotal,
      memories_by_type: memoriesByTypeRows.reduce<Partial<Record<MemoryType, number>>>(
        (grouped, row) => {
          if (row.name !== null) {
            grouped[row.name as MemoryType] = row.total;
          }

          return grouped;
        },
        {}
      ),
      memories_by_project: memoriesByProjectRows.reduce<Record<string, number>>((grouped, row) => {
        if (row.name !== null) {
          grouped[row.name] = row.total;
        }

        return grouped;
      }, {}),
      storage_bytes: getDatabaseSizeBytes(this.repository.db.name),
      avg_latency_ms: Number(avgLatency.toFixed(2)),
      active_projects: activeProjects,
      peak_hour: peakHourRow?.hour ? `${peakHourRow.hour}:00` : null
    };
  }

  getGrowthTrend(days: number): GrowthPoint[] {
    return this.getGrowthTrendForWindow(days);
  }

  getGrowthTrendForWindow(days: number, tenantId?: string): GrowthPoint[] {
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error("days must be a positive integer");
    }

    const startDate = new Date();
    startDate.setUTCHours(0, 0, 0, 0);
    startDate.setUTCDate(startDate.getUTCDate() - days + 1);

    const clauses = ["status = 'active'", "substr(created_at, 1, 10) >= ?"];
    const params: unknown[] = [formatDate(startDate)];

    if (tenantId !== undefined && this.hasColumn("memories", "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }

    const rows = this.repository.db
      .prepare<unknown[], DateCountRow>(
        `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS total
         FROM memories
         WHERE ${clauses.join(" AND ")}
         GROUP BY date
         ORDER BY date ASC`
      )
      .all(...params);
    const counts = new Map(rows.map((row) => [row.date, row.total]));

    return Array.from({ length: days }, (_, index) => {
      const current = new Date(startDate);
      current.setUTCDate(startDate.getUTCDate() + index);
      const date = formatDate(current);

      return {
        date,
        count: counts.get(date) ?? 0
      };
    });
  }

  getTopReusedMemories(limit: number, tenantId?: string): ImpactMemorySummary[] {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 5;
    const clauses = ["status = 'active'"];
    const params: unknown[] = [];

    if (tenantId !== undefined && this.hasColumn("memories", "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }

    return this.repository.db
      .prepare<unknown[], ImpactMemoryRow>(
        `SELECT id, title, project, type, access_count, updated_at, accessed_at
         FROM memories
         WHERE ${clauses.join(" AND ")}
         ORDER BY access_count DESC, updated_at DESC
         LIMIT ?`
      )
      .all(...params, safeLimit)
      .map((row) => ({
        id: row.id,
        title: row.title,
        project: row.project,
        type: row.type,
        access_count: row.access_count,
        updated_at: row.updated_at,
        explanation: `Top by lifetime access count (${row.access_count}) and last accessed on ${formatShortDate(row.accessed_at ?? row.updated_at)}.`
      }));
  }

  getWindowReuseSignals(
    limit: number,
    tenantId?: string,
    since?: string
  ): ImpactMemorySummary[] {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 5;
    const clauses = ["status = 'active'", "access_count > 0", "accessed_at IS NOT NULL"];
    const params: unknown[] = [];
    const normalizedSince = normalizeSince(since);

    if (normalizedSince !== undefined) {
      clauses.push("accessed_at >= ?");
      params.push(normalizedSince);
    }

    if (tenantId !== undefined && this.hasColumn("memories", "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }

    return this.repository.db
      .prepare<unknown[], ImpactMemoryRow>(
        `SELECT id, title, project, type, access_count, updated_at, accessed_at
         FROM memories
         WHERE ${clauses.join(" AND ")}
         ORDER BY accessed_at DESC, access_count DESC
         LIMIT ?`
      )
      .all(...params, safeLimit)
      .map((row) => ({
        id: row.id,
        title: row.title,
        project: row.project,
        type: row.type,
        access_count: row.access_count,
        updated_at: row.updated_at,
        explanation: `Recently reused in the current window, last accessed on ${formatShortDate(row.accessed_at ?? row.updated_at)}.`
      }));
  }

  private buildRuntimeReadinessDetail(
    runtimeReadiness?: "pass" | "warn" | "fail",
    runtimeReadinessSummary?: string,
    runtimeReadinessReasons?: string[],
    runtimeReadinessSuggestions?: string[]
  ): RuntimeReadinessDetail | undefined {
    if (runtimeReadiness === undefined) {
      return undefined;
    }

    return {
      status: runtimeReadiness,
      summary:
        runtimeReadinessSummary ??
        (runtimeReadiness === "pass"
          ? "All onboarding checks passed."
          : runtimeReadiness === "warn"
            ? "Some onboarding checks need attention."
            : "Onboarding is currently blocked by at least one failing check."),
      reasons: runtimeReadinessReasons ?? [],
      suggestions: runtimeReadinessSuggestions ?? []
    };
  }

  private buildRecommendedActions(options: {
    runtimeReadinessDetail?: RuntimeReadinessDetail;
    setupSurfaceCoverage?: Record<string, "configured" | "partial" | "missing">;
    newMemoriesThisWeek: number;
    activeProjects: number;
    recentReuseSignals: ImpactMemorySummary[];
  }): RecommendedAction[] {
    const actions: RecommendedAction[] = [];
    const coverageEntries = Object.entries(options.setupSurfaceCoverage ?? {});
    const missingTargets = coverageEntries
      .filter(([, state]) => state !== "configured")
      .map(([target, state]) => `${target} (${state})`);

    if (
      options.runtimeReadinessDetail &&
      options.runtimeReadinessDetail.status !== "pass"
    ) {
      actions.push({
        area: "runtime",
        title: "Resolve runtime readiness warnings",
        reason:
          options.runtimeReadinessDetail.suggestions[0] ??
          options.runtimeReadinessDetail.summary
      });
    }

    if (missingTargets.length > 0) {
      actions.push({
        area: "setup",
        title: "Finish connecting your agent surfaces",
        reason: `Still missing or partial: ${missingTargets.join(", ")}.`
      });
    }

    if (options.newMemoriesThisWeek === 0) {
      actions.push({
        area: "capture",
        title: "Store at least one real pitfall or decision this week",
        reason: "The current window has no new memories, so Vega cannot build a fresh reuse signal."
      });
    }

    if (options.recentReuseSignals.length === 0) {
      actions.push({
        area: "reuse",
        title: "Run one recall from a live task",
        reason: "No reused memories have surfaced yet, so the system cannot show later-session value."
      });
    }

    if (options.activeProjects <= 1) {
      actions.push({
        area: "adoption",
        title: "Expand Vega into one more active project or workflow",
        reason: "A second active project is the fastest way to validate cross-session and cross-context value."
      });
    }

    return actions.slice(0, 3);
  }

  private buildImpactConclusion(options: {
    runtimeReadinessDetail?: RuntimeReadinessDetail;
    setupSurfaceCoverage?: Record<string, "configured" | "partial" | "missing">;
    newMemoriesThisWeek: number;
    recentReuseSignals: ImpactMemorySummary[];
  }): ImpactConclusion {
    const configuredTargets = Object.values(options.setupSurfaceCoverage ?? {}).filter(
      (state) => state === "configured"
    ).length;

    if (options.runtimeReadinessDetail?.status === "fail") {
      return {
        status: "blocked",
        headline: "The memory loop is blocked by environment or setup issues.",
        detail:
          options.runtimeReadinessDetail.reasons[0] ??
          options.runtimeReadinessDetail.summary
      };
    }

    if (configuredTargets === 0) {
      return {
        status: "needs_attention",
        headline: "The runtime exists, but no agent surface is fully connected yet.",
        detail: "Finish at least one setup path so the next coding session can actually reuse memory."
      };
    }

    if (options.recentReuseSignals.length === 0) {
      return {
        status: "needs_attention",
        headline: "The system is ready, but reuse has not shown up in this window yet.",
        detail: "Capture and recall one real pitfall or decision to turn setup into visible value."
      };
    }

    return {
      status: "good",
      headline: "Vega is producing visible memory reuse in active workflows.",
      detail: `${options.recentReuseSignals.length} memories were reused inside the current reporting window, with ${options.newMemoriesThisWeek} new memories captured in the same period.`
    };
  }

  private buildWeeklyOverview(options: {
    newMemoriesThisWeek: number;
    activeProjects: number;
    recentReuseSignals: ImpactMemorySummary[];
    recommendedActions: RecommendedAction[];
  }): WeeklyOverview {
    if (options.recentReuseSignals.length === 0) {
      return {
        headline: "This week emphasized capture and setup readiness more than demonstrated reuse.",
        detail: `${options.newMemoriesThisWeek} new memories landed across ${options.activeProjects} active projects, but the top reused list is still empty.`
      };
    }

    return {
      headline: "This week produced reusable memory signals that can drive the next adoption step.",
      detail: `${options.newMemoriesThisWeek} new memories landed across ${options.activeProjects} active projects, and the strongest current-window reuse signal is "${options.recentReuseSignals[0]?.title ?? "Untitled memory"}".`
    };
  }

  getImpactReport(options?: {
    tenantId?: string;
    days?: number;
    runtimeReadiness?: "pass" | "warn" | "fail";
    runtimeReadinessSummary?: string;
    runtimeReadinessReasons?: string[];
    runtimeReadinessSuggestions?: string[];
    setupSurfaceCoverage?: Record<string, "configured" | "partial" | "missing">;
  }): ImpactReport {
    const windowDays = Number.isInteger(options?.days) && (options?.days ?? 0) > 0 ? options?.days ?? 7 : 7;
    const windowStart = toWindowStart(windowDays);
    const usage = this.getUsageStats(options?.tenantId, windowStart);
    const topReusedMemories = this.getTopReusedMemories(5, options?.tenantId);
    const recentReuseSignals = this.getWindowReuseSignals(5, options?.tenantId, windowStart);
    const runtimeReadinessDetail = this.buildRuntimeReadinessDetail(
      options?.runtimeReadiness,
      options?.runtimeReadinessSummary,
      options?.runtimeReadinessReasons,
      options?.runtimeReadinessSuggestions
    );
    const recommendedActions = this.buildRecommendedActions({
      runtimeReadinessDetail,
      setupSurfaceCoverage: options?.setupSurfaceCoverage,
      newMemoriesThisWeek: usage.memories_total,
      activeProjects: usage.active_projects,
      recentReuseSignals
    });

    return {
      generated_at: new Date().toISOString(),
      window_days: windowDays,
      usage,
      growth_trend: this.getGrowthTrendForWindow(windowDays, options?.tenantId),
      new_memories_this_week: usage.memories_total,
      top_reused_memories_basis: "lifetime_access_count",
      top_reused_memories: topReusedMemories,
      memory_mix: usage.memories_by_type,
      ...(options?.runtimeReadiness === undefined
        ? {}
        : { runtime_readiness: options.runtimeReadiness }),
      ...(runtimeReadinessDetail === undefined
        ? {}
        : { runtime_readiness_detail: runtimeReadinessDetail }),
      ...(options?.setupSurfaceCoverage === undefined
        ? {}
        : { setup_surface_coverage: options.setupSurfaceCoverage }),
      conclusion: this.buildImpactConclusion({
        runtimeReadinessDetail,
        setupSurfaceCoverage: options?.setupSurfaceCoverage,
        newMemoriesThisWeek: usage.memories_total,
        recentReuseSignals
      }),
      recommended_actions: recommendedActions
    };
  }

  getWeeklySummary(options?: {
    tenantId?: string;
    days?: number;
    runtimeReadiness?: "pass" | "warn" | "fail";
    runtimeReadinessSummary?: string;
    runtimeReadinessReasons?: string[];
    runtimeReadinessSuggestions?: string[];
    setupSurfaceCoverage?: Record<string, "configured" | "partial" | "missing">;
  }): WeeklySummary {
    const windowDays = Number.isInteger(options?.days) && (options?.days ?? 0) > 0 ? options?.days ?? 7 : 7;
    const windowStart = toWindowStart(windowDays);
    const usage = this.getUsageStats(options?.tenantId, windowStart);
    const topReusedMemories = this.getTopReusedMemories(5, options?.tenantId);
    const recentReuseSignals = this.getWindowReuseSignals(5, options?.tenantId, windowStart);
    const runtimeReadinessDetail = this.buildRuntimeReadinessDetail(
      options?.runtimeReadiness,
      options?.runtimeReadinessSummary,
      options?.runtimeReadinessReasons,
      options?.runtimeReadinessSuggestions
    );
    const recommendedActions = this.buildRecommendedActions({
      runtimeReadinessDetail,
      setupSurfaceCoverage: options?.setupSurfaceCoverage,
      newMemoriesThisWeek: usage.memories_total,
      activeProjects: usage.active_projects,
      recentReuseSignals
    });
    const resultTypeHits = this.getResultTypeHits(options?.tenantId, windowStart);
    const topSearchQueries = this.getTopSearchQueries(5, options?.tenantId, windowStart);
    const keySignals: string[] = [];

    if (topReusedMemories[0]) {
      keySignals.push(
        `Top reused memory: ${topReusedMemories[0].title} (${topReusedMemories[0].access_count} lifetime accesses).`
      );
    }

    const topResultHit = Object.entries(resultTypeHits).sort((left, right) => right[1] - left[1])[0];
    if (topResultHit) {
      keySignals.push(
        `Most frequent weekly recall hit type: ${topResultHit[0]} (${topResultHit[1]} hits).`
      );
    }

    if (topSearchQueries[0]) {
      keySignals.push(
        `Most common recall query this week: ${topSearchQueries[0].query} (${topSearchQueries[0].count} times).`
      );
    }

    return {
      generated_at: new Date().toISOString(),
      window_days: windowDays,
      new_memories_this_week: usage.memories_total,
      active_projects: usage.active_projects,
      api_calls_total: usage.api_calls_total,
      avg_latency_ms: usage.avg_latency_ms,
      peak_hour: usage.peak_hour,
      top_reused_memories_basis: "lifetime_access_count",
      top_reused_memories: topReusedMemories,
      memory_mix: usage.memories_by_type,
      result_type_hits: resultTypeHits,
      top_search_queries: topSearchQueries,
      overview: this.buildWeeklyOverview({
        newMemoriesThisWeek: usage.memories_total,
        activeProjects: usage.active_projects,
        recentReuseSignals,
        recommendedActions
      }),
      key_signals: keySignals,
      recommended_actions: recommendedActions
    };
  }

  getResultTypeHits(
    tenantId?: string,
    since?: string
  ): Partial<Record<MemoryType, number>> {
    const clauses = ["operation IN ('recall', 'recall_stream')"];
    const params: unknown[] = [];
    const normalizedSince = normalizeSince(since);

    if (normalizedSince !== undefined) {
      clauses.push("timestamp >= ?");
      params.push(normalizedSince);
    }

    if (tenantId !== undefined && this.hasColumn("performance_log", "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }

    const rows = this.repository.db
      .prepare<unknown[], ResultTypesRow>(
        `SELECT result_types
         FROM performance_log
         WHERE ${clauses.join(" AND ")}`
      )
      .all(...params);
    const counts: Partial<Record<MemoryType, number>> = {};

    for (const row of rows) {
      const resultTypes = parseJsonArray(row.result_types ?? "[]") as MemoryType[];
      for (const type of resultTypes) {
        counts[type] = (counts[type] ?? 0) + 1;
      }
    }

    return counts;
  }

  getTopSearchQueries(
    limit: number,
    tenantId?: string,
    since?: string
  ): Array<{ query: string; count: number }> {
    if (!this.hasColumn("performance_log", "detail")) {
      return [];
    }

    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 10;
    const clauses = ["operation IN ('recall', 'recall_stream')", "detail IS NOT NULL"];
    const params: unknown[] = [];
    const normalizedSince = normalizeSince(since);

    if (normalizedSince !== undefined) {
      clauses.push("timestamp >= ?");
      params.push(normalizedSince);
    }

    if (tenantId !== undefined && this.hasColumn("performance_log", "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(tenantId);
    }

    const rows = this.repository.db
      .prepare<unknown[], DetailRow>(
        `SELECT detail
         FROM performance_log
         WHERE ${clauses.join(" AND ")}`
      )
      .all(...params);
    const counts = new Map<string, number>();

    for (const row of rows) {
      const query = extractSearchQuery(row.detail);

      if (query === null) {
        continue;
      }

      counts.set(query, (counts.get(query) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([query, count]) => ({
        query,
        count
      }))
      .sort((left, right) => right.count - left.count || left.query.localeCompare(right.query))
      .slice(0, safeLimit);
  }
}
