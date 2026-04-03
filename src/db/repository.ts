import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";

import type { AuditEntry, Memory, MemoryVersion, PerformanceLog, Session } from "../core/types.js";
import { initializeDatabase } from "./schema.js";

interface MemoryRow {
  id: string;
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

export class Repository {
  readonly db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new BetterSqlite3(dbPath);
    initializeDatabase(this.db);
  }

  createMemory(memory: Omit<Memory, "access_count">): void {
    const insertMemory = this.db.prepare<
      [
        string,
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
        id, type, project, title, content, embedding, importance, source, tags,
        created_at, updated_at, accessed_at, status, verified, scope, accessed_projects
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFts = this.db.prepare<[number, string, string, string]>(
      "INSERT INTO memories_fts(rowid, title, content, tags) VALUES (?, ?, ?, ?)"
    );

    const transaction = this.db.transaction(() => {
      const result = insertMemory.run(
        memory.id,
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
        actor: "system",
        action: "create",
        memory_id: memory.id,
        detail: `Created memory ${memory.id}`,
        ip: null
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

  updateMemory(id: string, updates: Partial<Memory>): void {
    const existing = this.getMemory(id);
    if (!existing) {
      throw new Error(`Memory not found: ${id}`);
    }

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

    const updateStatement = this.db.prepare<
      [
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
        number,
        Memory["status"],
        Memory["verified"],
        Memory["scope"],
        string,
        string
      ]
    >(
      `UPDATE memories
       SET type = ?, project = ?, title = ?, content = ?, embedding = ?, importance = ?,
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
      this.createVersion(existing.id, existing.content, existing.embedding, existing.importance);

      updateStatement.run(
        nextMemory.type,
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
        actor: "system",
        action: "update",
        memory_id: id,
        detail: `Updated memory ${id}`,
        ip: null
      });
    });

    transaction();
  }

  deleteMemory(id: string): void {
    const existing = this.getMemory(id);
    const rowid = this.db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM memories WHERE id = ?")
      .get(id);

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
        actor: "system",
        action: "delete",
        memory_id: id,
        detail: `Deleted memory ${id}`,
        ip: null
      });
    });

    transaction();
  }

  listMemories(filters: {
    project?: string;
    type?: string;
    status?: string;
    scope?: string;
    limit?: number;
    sort?: string;
  }): Memory[] {
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

  searchFTS(query: string, project?: string, type?: string): { memory: Memory; rank: number }[] {
    const clauses = ["memories_fts MATCH ?"];
    const params: unknown[] = [query];

    if (project) {
      clauses.push("memories.project = ?");
      params.push(project);
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

  getAllEmbeddings(project?: string, type?: string): { id: string; embedding: Buffer; memory: Memory }[] {
    const clauses = ["embedding IS NOT NULL"];
    const params: unknown[] = [];

    if (project) {
      clauses.push("project = ?");
      params.push(project);
    }
    if (type) {
      clauses.push("type = ?");
      params.push(type);
    }

    const rows = this.db
      .prepare<unknown[], MemoryRow>(`SELECT * FROM memories WHERE ${clauses.join(" AND ")}`)
      .all(...params);

    return rows.map((row) => ({
      id: row.id,
      embedding: row.embedding as Buffer,
      memory: mapMemory(row)
    }));
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
      .prepare<[string, string, number, number, number]>(
        `INSERT INTO performance_log (timestamp, operation, latency_ms, memory_count, result_count)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        entry.timestamp,
        entry.operation,
        entry.latency_ms,
        entry.memory_count,
        entry.result_count
      );
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

  close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }
}
