import type Database from "better-sqlite3";

export function initializeDatabase(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      importance REAL NOT NULL,
      source TEXT NOT NULL,
      tags TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      accessed_at TEXT NOT NULL,
      access_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      verified TEXT DEFAULT 'unverified',
      scope TEXT DEFAULT 'project',
      accessed_projects TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      importance REAL NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      summary TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      memories_created TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      memory_id TEXT,
      detail TEXT NOT NULL,
      ip TEXT
    );

    CREATE TABLE IF NOT EXISTS performance_log (
      timestamp TEXT NOT NULL,
      operation TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      memory_count INTEGER NOT NULL,
      result_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(source_entity_id, target_entity_id, relation_type, memory_id),
      FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_relations_source_entity
      ON relations(source_entity_id);

    CREATE INDEX IF NOT EXISTS idx_relations_target_entity
      ON relations(target_entity_id);

    CREATE INDEX IF NOT EXISTS idx_relations_memory
      ON relations(memory_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(title, content, tags, content=memories, content_rowid=rowid);
  `);
}
