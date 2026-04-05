import type Database from "better-sqlite3";

interface TableColumnRow {
  name: string;
}

const ensureColumn = (
  db: Database.Database,
  tableName: string,
  columnName: string,
  definition: string
): void => {
  const columns = db
    .prepare<[], TableColumnRow>(`PRAGMA table_info(${tableName})`)
    .all();

  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
};

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
      result_count INTEGER NOT NULL,
      avg_similarity REAL,
      result_types TEXT NOT NULL DEFAULT '[]',
      bm25_result_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'member', 'readonly')),
      joined_at TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id),
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      api_key TEXT UNIQUE NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      memory_limit INTEGER NOT NULL DEFAULT 1000,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      month TEXT NOT NULL,
      memory_count INTEGER DEFAULT 0,
      api_calls INTEGER DEFAULT 0,
      storage_bytes INTEGER DEFAULT 0,
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

    CREATE INDEX IF NOT EXISTS idx_team_members_team
      ON team_members(team_id);

    CREATE INDEX IF NOT EXISTS idx_team_members_user
      ON team_members(user_id);

    CREATE INDEX IF NOT EXISTS idx_tenants_active
      ON tenants(active);

    CREATE INDEX IF NOT EXISTS idx_usage_log_tenant_month
      ON usage_log(tenant_id, month);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(title, content, tags, content=memories, content_rowid=rowid);
  `);

  ensureColumn(db, "performance_log", "avg_similarity", "REAL");
  ensureColumn(db, "performance_log", "result_types", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "performance_log", "bm25_result_count", "INTEGER NOT NULL DEFAULT 0");
}
