import { Repository } from "../db/repository.js";
import type { AuditEntry, AuditQueryFilters } from "./types.js";

interface CountRow {
  total: number;
}

interface ValueRow {
  value: string;
}

const normalizeLimit = (value?: number): number => {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return 50;
  }

  return value;
};

const normalizeOffset = (value?: number): number => {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return 0;
  }

  return value;
};

const buildAuditWhereClause = (
  filters: Omit<AuditQueryFilters, "limit" | "offset">
): { where: string; params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.actor) {
    clauses.push("actor = ?");
    params.push(filters.actor);
  }
  if (filters.action) {
    clauses.push("action = ?");
    params.push(filters.action);
  }
  if (filters.memoryId) {
    clauses.push("memory_id = ?");
    params.push(filters.memoryId);
  }
  if (filters.since) {
    clauses.push("timestamp >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    clauses.push("timestamp <= ?");
    params.push(filters.until);
  }
  if (filters.tenantId !== undefined) {
    clauses.push("tenant_id IS ?");
    params.push(filters.tenantId);
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
};

export class AuditService {
  constructor(private readonly repository: Repository) {}

  log(
    action: string,
    actor: string,
    detail: string,
    options?: {
      memoryId?: string;
      ip?: string | null;
      tenantId?: string | null;
    }
  ): void {
    this.repository.logAudit({
      timestamp: new Date().toISOString(),
      actor,
      action,
      memory_id: options?.memoryId ?? null,
      detail,
      ip: options?.ip ?? null,
      tenant_id: options?.tenantId ?? null
    });
  }

  query(filters: AuditQueryFilters = {}): AuditEntry[] {
    const { where, params } = buildAuditWhereClause(filters);

    return this.repository.db
      .prepare<unknown[], AuditEntry>(
        `SELECT id, timestamp, actor, action, memory_id, detail, ip, tenant_id
         FROM audit_log
         ${where}
         ORDER BY timestamp DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, normalizeLimit(filters.limit), normalizeOffset(filters.offset));
  }

  count(filters: Omit<AuditQueryFilters, "limit" | "offset"> = {}): number {
    const { where, params } = buildAuditWhereClause(filters);
    const row = this.repository.db
      .prepare<unknown[], CountRow>(`SELECT COUNT(*) AS total FROM audit_log ${where}`)
      .get(...params);

    return row?.total ?? 0;
  }

  getActions(): string[] {
    return this.repository.db
      .prepare<[], ValueRow>(
        `SELECT DISTINCT action AS value
         FROM audit_log
         ORDER BY action ASC`
      )
      .all()
      .map((row) => row.value);
  }

  getActors(tenantId?: string): string[] {
    const rows =
      tenantId === undefined
        ? this.repository.db
            .prepare<[], ValueRow>(
              `SELECT DISTINCT actor AS value
               FROM audit_log
               ORDER BY actor ASC`
            )
            .all()
        : this.repository.db
            .prepare<[string], ValueRow>(
              `SELECT DISTINCT actor AS value
               FROM audit_log
               WHERE tenant_id = ?
               ORDER BY actor ASC`
            )
            .all(tenantId);

    return rows.map((row) => row.value);
  }

  purge(before: Date): number {
    const threshold = before.toISOString();
    const count =
      this.repository.db
        .prepare<[string], { total: number }>(
          `SELECT COUNT(*) AS total
           FROM audit_log
           WHERE timestamp < ?`
        )
        .get(threshold)?.total ?? 0;

    this.repository.db
      .prepare<[string]>(
        `DELETE FROM audit_log
         WHERE timestamp < ?`
      )
      .run(threshold);

    return count;
  }
}

export const buildAuditFiltersForQuery = buildAuditWhereClause;
