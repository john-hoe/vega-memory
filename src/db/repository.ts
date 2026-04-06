import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";

import type {
  AuditContext,
  AuditEntry,
  Entity,
  EntityRelation,
  GraphTraversal,
  Memory,
  MemoryListFilters,
  MemoryVersion,
  PerformanceLog,
  RelationType,
  Session
} from "../core/types.js";
import { initializeDatabase } from "./schema.js";

interface MemoryRow {
  id: string;
  tenant_id: string | null;
  type: Memory["type"];
  project: string;
  title: string;
  content: string;
  embedding: Buffer | null;
  importance: number;
  source: Memory["source"];
  tags: string;
  created_at: string;
  updated_at: string;
  accessed_at: string;
  access_count: number;
  status: Memory["status"];
  verified: Memory["verified"];
  scope: Memory["scope"];
  accessed_projects: string;
}

interface AuditRow {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  memory_id: string | null;
  detail: string;
  ip: string | null;
}

interface MemoryVersionRow {
  id: string;
  memory_id: string;
  content: string;
  embedding: Buffer | null;
  importance: number;
  updated_at: string;
}

interface MetadataRow {
  key: string;
  value: string;
  updated_at: string;
}

interface CountRow {
  total: number;
}

interface EmbeddingIndexSnapshotRow {
  total: number;
  latest_updated_at: string | null;
  total_bytes: number | null;
}

interface PerformanceLogRow {
  timestamp: string;
  tenant_id: string | null;
  operation: string;
  latency_ms: number;
  memory_count: number;
  result_count: number;
  avg_similarity: number | null;
  result_types: string | null;
  bm25_result_count: number | null;
}

interface EntityRow {
  id: string;
  name: string;
  type: Entity["type"];
  created_at: string;
}

interface EntityRelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: RelationType;
  memory_id: string;
  created_at: string;
  source_entity_name: string;
  source_entity_type: Entity["type"];
  target_entity_name: string;
  target_entity_type: Entity["type"];
}

const SORT_COLUMNS = new Set([
  "id",
  "type",
  "project",
  "title",
  "importance",
  "created_at",
  "updated_at",
  "accessed_at",
  "access_count",
  "status",
  "verified",
  "scope"
]);

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
}

function serializeJsonArray(value: string[]): string {
  return JSON.stringify(value);
}

function mapMemory(row: MemoryRow): Memory {
  return {
    ...row,
    tags: parseJsonArray(row.tags),
    accessed_projects: parseJsonArray(row.accessed_projects)
  };
}

function mapEntity(row: EntityRow): Entity {
  return row;
}

function mapEntityRelation(row: EntityRelationRow): EntityRelation {
  return row;
}

function mapPerformanceLog(row: PerformanceLogRow): PerformanceLog {
  return {
    timestamp: row.timestamp,
    tenant_id: row.tenant_id,
    operation: row.operation,
    latency_ms: row.latency_ms,
    memory_count: row.memory_count,
    result_count: row.result_count,
    avg_similarity: row.avg_similarity,
    result_types: parseJsonArray(row.result_types ?? "[]") as PerformanceLog["result_types"],
    bm25_result_count: row.bm25_result_count ?? 0
  };
}

function appendScopedClauses(
  clauses: string[],
  params: unknown[],
  project?: string,
  type?: string,
  includeGlobal = false,
  embeddingRequired = false
): void {
  if (embeddingRequired) {
    clauses.push("embedding IS NOT NULL");
  }

  clauses.push("status = 'active'");

  if (project) {
    if (includeGlobal) {
      clauses.push("(project = ? OR scope = 'global')");
      params.push(project);
    } else {
      clauses.push("project = ?");
      params.push(project);
    }
  }

  if (type) {
    clauses.push("type = ?");
    params.push(type);
  }
}

function normalizeSort(sort?: string): string {
  if (!sort) {
    return "updated_at DESC";
  }

  const match = /^([a-z_]+)(?:\s+(ASC|DESC))?$/i.exec(sort.trim());
  if (!match) {
    throw new Error(`Unsupported sort: ${sort}`);
  }

  const [, column, direction = "ASC"] = match;
  if (!SORT_COLUMNS.has(column)) {
    throw new Error(`Unsupported sort column: ${column}`);
  }

  return `${column} ${direction.toUpperCase()}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

const resolveAuditContext = (auditContext?: AuditContext): AuditContext => ({
  actor: auditContext?.actor ?? "system",
  ip: auditContext?.ip ?? null
});

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export class Repository {
  readonly db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new BetterSqlite3(dbPath);
    initializeDatabase(this.db);
  }

  createMemory(memory: Omit<Memory, "access_count">, auditContext?: AuditContext): void {
    const resolvedAuditContext = resolveAuditContext(auditContext);
    const insertMemory = this.db.prepare<
      [
        string,
        string | null,
        Memory["type"],
        string,
        string,
        string,
        Buffer | null,
        number,
        Memory["source"],
        string,
        string,
        string,
        string,
        Memory["status"],
        Memory["verified"],
        Memory["scope"],
        string
      ]
    >(
      `INSERT INTO memories (
        id, tenant_id, type, project, title, content, embedding, importance, source, tags,
        created_at, updated_at, accessed_at, status, verified, scope, accessed_projects
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFts = this.db.prepare<[number, string, string, string]>(
      "INSERT INTO memories_fts(rowid, title, content, tags) VALUES (?, ?, ?, ?)"
    );

    const transaction = this.db.transaction(() => {
      const result = insertMemory.run(
        memory.id,
        memory.tenant_id ?? null,
        memory.type,
        memory.project,
        memory.title,
        memory.content,
        memory.embedding,
        memory.importance,
        memory.source,
        serializeJsonArray(memory.tags),
        memory.created_at,
        memory.updated_at,
        memory.accessed_at,
        memory.status,
        memory.verified,
        memory.scope,
        serializeJsonArray(memory.accessed_projects)
      );

      insertFts.run(
        Number(result.lastInsertRowid),
        memory.title,
        memory.content,
        serializeJsonArray(memory.tags)
      );

      this.logAudit({
        timestamp: timestamp(),
        actor: resolvedAuditContext.actor,
        action: "create",
        memory_id: memory.id,
        detail: `Created memory ${memory.id}`,
        ip: resolvedAuditContext.ip
      });
    });

    transaction();
  }

  getMemory(id: string): Memory | null {
    const row = this.db
      .prepare<[string], MemoryRow>("SELECT * FROM memories WHERE id = ?")
      .get(id);

    return row ? mapMemory(row) : null;
  }

  getMemoriesByIds(ids: string[]): Memory[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare<unknown[], MemoryRow>(
        `SELECT * FROM memories WHERE id IN (${placeholders}) ORDER BY updated_at DESC`
      )
      .all(...ids);

    return rows.map(mapMemory);
  }

  updateMemory(
    id: string,
    updates: Partial<Memory>,
    options?: { skipVersion?: boolean; auditContext?: AuditContext }
  ): void {
    const existing = this.getMemory(id);
    if (!existing) {
      throw new Error(`Memory not found: ${id}`);
    }
    const resolvedAuditContext = resolveAuditContext(options?.auditContext);

    const nextMemory: Memory = {
      ...existing,
      ...updates,
      id: existing.id,
      access_count: updates.access_count ?? existing.access_count,
      tags: updates.tags ?? existing.tags,
      accessed_projects: updates.accessed_projects ?? existing.accessed_projects
    };
    const rowid = this.db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM memories WHERE id = ?")
      .get(id);

    if (!rowid) {
      throw new Error(`Memory rowid not found: ${id}`);
    }

    const shouldCreateVersion =
      options?.skipVersion !== true &&
      (nextMemory.content !== existing.content ||
        nextMemory.importance !== existing.importance ||
        !arraysEqual(nextMemory.tags, existing.tags));

    const updateStatement = this.db.prepare<
      [
        Memory["type"],
        string | null,
        string,
        string,
        string,
        Buffer | null,
        number,
        Memory["source"],
        string,
        string,
        string,
        number,
        Memory["status"],
        Memory["verified"],
        Memory["scope"],
        string,
        string
      ]
    >(
      `UPDATE memories
       SET type = ?, tenant_id = ?, project = ?, title = ?, content = ?, embedding = ?, importance = ?,
           source = ?, tags = ?, updated_at = ?, accessed_at = ?, access_count = ?,
           status = ?, verified = ?, scope = ?, accessed_projects = ?
       WHERE id = ?`
    );
    const deleteFts = this.db.prepare<[number, string, string, string]>(
      "INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', ?, ?, ?, ?)"
    );
    const insertFts = this.db.prepare<[number, string, string, string]>(
      "INSERT INTO memories_fts(rowid, title, content, tags) VALUES (?, ?, ?, ?)"
    );

    const transaction = this.db.transaction(() => {
      if (shouldCreateVersion) {
        this.createVersion(existing.id, existing.content, existing.embedding, existing.importance);
      }

      updateStatement.run(
        nextMemory.type,
        nextMemory.tenant_id ?? null,
        nextMemory.project,
        nextMemory.title,
        nextMemory.content,
        nextMemory.embedding,
        nextMemory.importance,
        nextMemory.source,
        serializeJsonArray(nextMemory.tags),
        nextMemory.updated_at,
        nextMemory.accessed_at,
        nextMemory.access_count,
        nextMemory.status,
        nextMemory.verified,
        nextMemory.scope,
        serializeJsonArray(nextMemory.accessed_projects),
        id
      );

      deleteFts.run(
        rowid.rowid,
        existing.title,
        existing.content,
        serializeJsonArray(existing.tags)
      );
      insertFts.run(
        rowid.rowid,
        nextMemory.title,
        nextMemory.content,
        serializeJsonArray(nextMemory.tags)
      );

      this.logAudit({
        timestamp: timestamp(),
        actor: resolvedAuditContext.actor,
        action: "update",
        memory_id: id,
        detail: `Updated memory ${id}`,
        ip: resolvedAuditContext.ip
      });
    });

    transaction();
  }

  deleteMemory(id: string, auditContext?: AuditContext): void {
    const existing = this.getMemory(id);
    const rowid = this.db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM memories WHERE id = ?")
      .get(id);
    const resolvedAuditContext = resolveAuditContext(auditContext);

    if (!existing || !rowid) {
      return;
    }

    const deleteMemory = this.db.prepare<[string]>("DELETE FROM memories WHERE id = ?");
    const deleteFts = this.db.prepare<[number, string, string, string]>(
      "INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', ?, ?, ?, ?)"
    );

    const transaction = this.db.transaction(() => {
      deleteFts.run(
        rowid.rowid,
        existing.title,
        existing.content,
        serializeJsonArray(existing.tags)
      );
      deleteMemory.run(id);

      this.logAudit({
        timestamp: timestamp(),
        actor: resolvedAuditContext.actor,
        action: "delete",
        memory_id: id,
        detail: `Deleted memory ${id}`,
        ip: resolvedAuditContext.ip
      });
    });

    transaction();
  }

  listMemories(filters: MemoryListFilters): Memory[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.project) {
      clauses.push("project = ?");
      params.push(filters.project);
    }
    if (filters.type) {
      clauses.push("type = ?");
      params.push(filters.type);
    }
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters.scope) {
      clauses.push("scope = ?");
      params.push(filters.scope);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const orderBy = normalizeSort(filters.sort);
    const limit = filters.limit ?? 100;
    const rows = this.db
      .prepare<unknown[], MemoryRow>(`SELECT * FROM memories ${where} ORDER BY ${orderBy} LIMIT ?`)
      .all(...params, limit);

    return rows.map(mapMemory);
  }

  searchFTS(
    query: string,
    project?: string,
    type?: string,
    includeGlobal = false
  ): { memory: Memory; rank: number }[] {
    const clauses = ["memories_fts MATCH ?", "memories.status = 'active'"];
    const params: unknown[] = [query];

    if (project) {
      if (includeGlobal) {
        clauses.push("(memories.project = ? OR memories.scope = 'global')");
        params.push(project);
      } else {
        clauses.push("memories.project = ?");
        params.push(project);
      }
    }
    if (type) {
      clauses.push("memories.type = ?");
      params.push(type);
    }

    const rows = this.db
      .prepare<
        unknown[],
        MemoryRow & {
          rank: number;
        }
      >(
        `SELECT memories.*, bm25(memories_fts) AS rank
         FROM memories_fts
         JOIN memories ON memories.rowid = memories_fts.rowid
         WHERE ${clauses.join(" AND ")}
         ORDER BY rank`
      )
      .all(...params);

    return rows.map((row) => ({
      memory: mapMemory(row),
      rank: row.rank
    }));
  }

  getAllEmbeddings(
    project?: string,
    type?: string,
    includeGlobal = false
  ): { id: string; embedding: Buffer; memory: Memory }[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    appendScopedClauses(clauses, params, project, type, includeGlobal, true);

    const rows = this.db
      .prepare<unknown[], MemoryRow>(`SELECT * FROM memories WHERE ${clauses.join(" AND ")}`)
      .all(...params);

    return rows.map((row) => ({
      id: row.id,
      embedding: row.embedding as Buffer,
      memory: mapMemory(row)
    }));
  }

  getEmbeddingChunk(
    offset: number,
    limit: number,
    project?: string,
    type?: string,
    includeGlobal = false
  ): { id: string; embedding: Buffer; memory: Memory }[] {
    const safeOffset = normalizeNonNegativeInteger(offset);
    const safeLimit = normalizePositiveInteger(limit, 0);
    if (safeLimit === 0) {
      return [];
    }

    const clauses: string[] = [];
    const params: unknown[] = [];
    appendScopedClauses(clauses, params, project, type, includeGlobal, true);

    const rows = this.db
      .prepare<unknown[], MemoryRow>(
        `SELECT * FROM memories
         WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, safeLimit, safeOffset);

    return rows.map((row) => ({
      id: row.id,
      embedding: row.embedding as Buffer,
      memory: mapMemory(row)
    }));
  }

  countEmbeddings(project?: string, type?: string, includeGlobal = false): number {
    const clauses: string[] = [];
    const params: unknown[] = [];
    appendScopedClauses(clauses, params, project, type, includeGlobal, true);

    const row = this.db
      .prepare<unknown[], CountRow>(
        `SELECT COUNT(*) AS total FROM memories WHERE ${clauses.join(" AND ")}`
      )
      .get(...params);

    return row?.total ?? 0;
  }

  countActiveMemories(project?: string, type?: string, includeGlobal = false): number {
    const clauses: string[] = [];
    const params: unknown[] = [];
    appendScopedClauses(clauses, params, project, type, includeGlobal);

    const row = this.db
      .prepare<unknown[], CountRow>(
        `SELECT COUNT(*) AS total FROM memories WHERE ${clauses.join(" AND ")}`
      )
      .get(...params);

    return row?.total ?? 0;
  }

  getEmbeddingIndexSnapshot(): {
    count: number;
    latestUpdatedAt: string | null;
    totalBytes: number;
  } {
    const row = this.db
      .prepare<[], EmbeddingIndexSnapshotRow>(
        `SELECT
           COUNT(*) AS total,
           MAX(updated_at) AS latest_updated_at,
           SUM(length(embedding)) AS total_bytes
         FROM memories
         WHERE embedding IS NOT NULL AND status = 'active'`
      )
      .get();

    return {
      count: row?.total ?? 0,
      latestUpdatedAt: row?.latest_updated_at ?? null,
      totalBytes: row?.total_bytes ?? 0
    };
  }

  createSession(session: Session): void {
    this.db
      .prepare<[string, string, string, string, string, string]>(
        `INSERT INTO sessions (id, project, summary, started_at, ended_at, memories_created)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.project,
        session.summary,
        session.started_at,
        session.ended_at,
        serializeJsonArray(session.memories_created)
      );
  }

  createEntity(name: string, type: Entity["type"]): Entity {
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      throw new Error("Entity name cannot be empty");
    }

    const existing = this.findEntity(normalizedName);
    if (existing) {
      if (existing.type !== type) {
        this.db
          .prepare<[Entity["type"], string]>("UPDATE entities SET type = ? WHERE id = ?")
          .run(type, existing.id);

        return {
          ...existing,
          type
        };
      }

      return existing;
    }

    const entity: Entity = {
      id: uuidv4(),
      name: normalizedName,
      type,
      created_at: timestamp()
    };

    this.db
      .prepare<[string, string, Entity["type"], string]>(
        "INSERT INTO entities (id, name, type, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(entity.id, entity.name, entity.type, entity.created_at);

    return entity;
  }

  createRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    memoryId: string
  ): void {
    this.db
      .prepare<[string, string, string, RelationType, string, string]>(
        `INSERT OR IGNORE INTO relations (
          id, source_entity_id, target_entity_id, relation_type, memory_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(uuidv4(), sourceId, targetId, relationType, memoryId, timestamp());
  }

  deleteRelationsForMemory(memoryId: string): void {
    this.db.prepare<[string]>("DELETE FROM relations WHERE memory_id = ?").run(memoryId);
  }

  getEntityRelations(entityId: string): EntityRelation[] {
    const rows = this.db
      .prepare<[string, string], EntityRelationRow>(
        `SELECT
           relations.id,
           relations.source_entity_id,
           relations.target_entity_id,
           relations.relation_type,
           relations.memory_id,
           relations.created_at,
           source.name AS source_entity_name,
           source.type AS source_entity_type,
           target.name AS target_entity_name,
           target.type AS target_entity_type
         FROM relations
         JOIN entities AS source ON source.id = relations.source_entity_id
         JOIN entities AS target ON target.id = relations.target_entity_id
         WHERE relations.source_entity_id = ? OR relations.target_entity_id = ?
         ORDER BY relations.created_at ASC`
      )
      .all(entityId, entityId);

    return rows.map(mapEntityRelation);
  }

  findEntity(name: string): Entity | null {
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      return null;
    }

    const row = this.db
      .prepare<[string], EntityRow>("SELECT * FROM entities WHERE lower(name) = lower(?)")
      .get(normalizedName);

    return row ? mapEntity(row) : null;
  }

  private getEntitiesByIds(ids: string[]): Entity[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare<unknown[], EntityRow>(
        `SELECT * FROM entities WHERE id IN (${placeholders}) ORDER BY name ASC`
      )
      .all(...ids);

    return rows.map(mapEntity);
  }

  traverseGraph(entityId: string, depth: number): GraphTraversal {
    if (depth <= 0) {
      return {
        entities: this.getEntitiesByIds([entityId]),
        relations: []
      };
    }

    const visitedEntityIds = new Set<string>([entityId]);
    const relationById = new Map<string, EntityRelation>();
    let frontier = [entityId];

    for (let level = 0; level < depth; level += 1) {
      const nextFrontier: string[] = [];

      for (const currentEntityId of frontier) {
        for (const relation of this.getEntityRelations(currentEntityId)) {
          relationById.set(relation.id, relation);

          const relatedEntityId =
            relation.source_entity_id === currentEntityId
              ? relation.target_entity_id
              : relation.source_entity_id;

          if (!visitedEntityIds.has(relatedEntityId)) {
            visitedEntityIds.add(relatedEntityId);
            nextFrontier.push(relatedEntityId);
          }
        }
      }

      if (nextFrontier.length === 0) {
        break;
      }

      frontier = nextFrontier;
    }

    return {
      entities: this.getEntitiesByIds([...visitedEntityIds]),
      relations: [...relationById.values()]
    };
  }

  logAudit(entry: Omit<AuditEntry, "id">): void {
    this.db
      .prepare<[string, string, string, string | null, string, string | null]>(
        `INSERT INTO audit_log (timestamp, actor, action, memory_id, detail, ip)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(entry.timestamp, entry.actor, entry.action, entry.memory_id, entry.detail, entry.ip);
  }

  logPerformance(entry: PerformanceLog): void {
    this.db
      .prepare<[string, string | null, string, number, number, number, number | null, string, number]>(
        `INSERT INTO performance_log (
           timestamp,
           tenant_id,
           operation,
           latency_ms,
           memory_count,
           result_count,
           avg_similarity,
           result_types,
           bm25_result_count
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.timestamp,
        entry.tenant_id ?? null,
        entry.operation,
        entry.latency_ms,
        entry.memory_count,
        entry.result_count,
        entry.avg_similarity ?? null,
        serializeJsonArray((entry.result_types ?? []) as string[]),
        entry.bm25_result_count ?? 0
      );
  }

  getRecentPerformanceLogs(limit = 100, operations?: string | string[]): PerformanceLog[] {
    const operationList =
      (operations === undefined ? [] : Array.isArray(operations) ? operations : [operations])
        .map((operation) => operation.trim())
        .filter((operation) => operation.length > 0);
    const safeLimit = normalizePositiveInteger(limit, 100);
    const params: unknown[] = [];
    const where =
      operationList.length === 0
        ? ""
        : `WHERE operation IN (${operationList.map(() => "?").join(", ")})`;

    const rows = this.db
      .prepare<unknown[], PerformanceLogRow>(
        `SELECT *
         FROM performance_log
         ${where}
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(...operationList, safeLimit);

    return rows.map(mapPerformanceLog);
  }

  getAuditLog(filters?: {
    actor?: string;
    action?: string;
    since?: string;
    memory_id?: string;
  }): AuditEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.actor) {
      clauses.push("actor = ?");
      params.push(filters.actor);
    }
    if (filters?.action) {
      clauses.push("action = ?");
      params.push(filters.action);
    }
    if (filters?.since) {
      clauses.push("timestamp >= ?");
      params.push(filters.since);
    }
    if (filters?.memory_id) {
      clauses.push("memory_id = ?");
      params.push(filters.memory_id);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare<unknown[], AuditRow>(`SELECT * FROM audit_log ${where} ORDER BY id ASC`)
      .all(...params);

    return rows;
  }

  createVersion(
    memoryId: string,
    oldContent: string,
    oldEmbedding: Buffer | null,
    oldImportance: number
  ): void {
    this.db
      .prepare<[string, string, string, Buffer | null, number, string]>(
        `INSERT INTO memory_versions (id, memory_id, content, embedding, importance, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(uuidv4(), memoryId, oldContent, oldEmbedding, oldImportance, timestamp());
  }

  getVersions(memoryId: string): MemoryVersion[] {
    return this.db
      .prepare<[string], MemoryVersionRow>(
        "SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY updated_at DESC"
      )
      .all(memoryId);
  }

  getMetadata(key: string): string | null {
    const row = this.db
      .prepare<[string], MetadataRow>("SELECT * FROM metadata WHERE key = ?")
      .get(key);

    return row?.value ?? null;
  }

  setMetadata(key: string, value: string): void {
    this.db
      .prepare<[string, string, string]>(
        `INSERT INTO metadata (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, timestamp());
  }

  deleteMetadata(key: string): void {
    this.db.prepare<[string]>("DELETE FROM metadata WHERE key = ?").run(key);
  }

  close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }
}
