import type {
  GrowthPoint,
  ImpactMemorySummary,
  ImpactReport,
  MemoryType,
  UsageStats,
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
        `SELECT id, title, project, type, access_count, updated_at
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
        updated_at: row.updated_at
      }));
  }

  getImpactReport(options?: {
    tenantId?: string;
    days?: number;
    runtimeReadiness?: "pass" | "warn" | "fail";
    setupSurfaceCoverage?: Record<string, "configured" | "partial" | "missing">;
  }): ImpactReport {
    const windowDays = Number.isInteger(options?.days) && (options?.days ?? 0) > 0 ? options?.days ?? 7 : 7;
    const windowStart = toWindowStart(windowDays);
    const usage = this.getUsageStats(options?.tenantId, windowStart);

    return {
      generated_at: new Date().toISOString(),
      window_days: windowDays,
      usage,
      growth_trend: this.getGrowthTrendForWindow(windowDays, options?.tenantId),
      new_memories_this_week: usage.memories_total,
      top_reused_memories_basis: "lifetime_access_count",
      top_reused_memories: this.getTopReusedMemories(5, options?.tenantId),
      memory_mix: usage.memories_by_type,
      ...(options?.runtimeReadiness === undefined
        ? {}
        : { runtime_readiness: options.runtimeReadiness }),
      ...(options?.setupSurfaceCoverage === undefined
        ? {}
        : { setup_surface_coverage: options.setupSurfaceCoverage })
    };
  }

  getWeeklySummary(options?: {
    tenantId?: string;
    days?: number;
  }): WeeklySummary {
    const windowDays = Number.isInteger(options?.days) && (options?.days ?? 0) > 0 ? options?.days ?? 7 : 7;
    const windowStart = toWindowStart(windowDays);
    const usage = this.getUsageStats(options?.tenantId, windowStart);

    return {
      generated_at: new Date().toISOString(),
      window_days: windowDays,
      new_memories_this_week: usage.memories_total,
      active_projects: usage.active_projects,
      api_calls_total: usage.api_calls_total,
      avg_latency_ms: usage.avg_latency_ms,
      peak_hour: usage.peak_hour,
      top_reused_memories_basis: "lifetime_access_count",
      top_reused_memories: this.getTopReusedMemories(5, options?.tenantId),
      memory_mix: usage.memories_by_type,
      result_type_hits: this.getResultTypeHits(options?.tenantId, windowStart),
      top_search_queries: this.getTopSearchQueries(5)
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

  getTopSearchQueries(limit: number): Array<{ query: string; count: number }> {
    if (!this.hasColumn("performance_log", "detail")) {
      return [];
    }

    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 10;
    const rows = this.repository.db
      .prepare<[], DetailRow>(
        `SELECT detail
         FROM performance_log
         WHERE operation IN ('recall', 'recall_stream') AND detail IS NOT NULL`
      )
      .all();
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
