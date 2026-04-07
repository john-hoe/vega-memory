import type Database from "better-sqlite3-multiple-ciphers";

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
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      type TEXT NOT NULL,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
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
      ip TEXT,
      tenant_id TEXT
    );

    CREATE TABLE IF NOT EXISTS performance_log (
      timestamp TEXT NOT NULL,
      tenant_id TEXT,
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

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      sso_provider TEXT,
      sso_subject TEXT,
      created_at TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      page_type TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'project',
      project TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      source_memory_ids TEXT NOT NULL DEFAULT '[]',
      embedding BLOB,
      status TEXT NOT NULL DEFAULT 'draft',
      auto_generated INTEGER NOT NULL DEFAULT 1,
      reviewed INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      space_id TEXT,
      parent_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_at TEXT,
      published_at TEXT,
      FOREIGN KEY (space_id) REFERENCES wiki_spaces(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_id) REFERENCES wiki_pages(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS wiki_spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'internal',
      created_at TEXT NOT NULL,
      UNIQUE(slug, tenant_id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wiki_page_permissions (
      page_id TEXT NOT NULL,
      user_id TEXT,
      role TEXT,
      level TEXT NOT NULL,
      UNIQUE(page_id, user_id),
      CHECK ((user_id IS NOT NULL AND role IS NULL) OR (user_id IS NULL AND role IS NOT NULL)),
      FOREIGN KEY (page_id) REFERENCES wiki_pages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wiki_page_versions (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      version INTEGER NOT NULL,
      change_reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (page_id) REFERENCES wiki_pages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wiki_cross_references (
      id TEXT PRIMARY KEY,
      source_page_id TEXT NOT NULL,
      target_page_id TEXT NOT NULL,
      context TEXT NOT NULL,
      auto_generated INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (source_page_id) REFERENCES wiki_pages(id) ON DELETE CASCADE,
      FOREIGN KEY (target_page_id) REFERENCES wiki_pages(id) ON DELETE CASCADE,
      UNIQUE(source_page_id, target_page_id)
    );

    CREATE TABLE IF NOT EXISTS wiki_contradictions (
      id TEXT PRIMARY KEY,
      page_a_id TEXT NOT NULL,
      page_b_id TEXT NOT NULL,
      statement_a TEXT NOT NULL,
      statement_b TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (page_a_id) REFERENCES wiki_pages(id) ON DELETE CASCADE,
      FOREIGN KEY (page_b_id) REFERENCES wiki_pages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wiki_comments (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      mentions TEXT NOT NULL DEFAULT '[]',
      parent_comment_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      FOREIGN KEY (page_id) REFERENCES wiki_pages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_comment_id) REFERENCES wiki_comments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wiki_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      message TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS content_sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      url TEXT,
      title TEXT NOT NULL,
      raw_content TEXT NOT NULL,
      extracted_at TEXT NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0,
      project TEXT,
      tags TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS rss_feeds (
      id TEXT PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      project TEXT,
      last_polled_at TEXT,
      last_entry_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
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

    CREATE INDEX IF NOT EXISTS idx_users_tenant_id
      ON users(tenant_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_identity
      ON users(sso_provider, sso_subject)
      WHERE sso_provider IS NOT NULL AND sso_subject IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_wiki_pages_slug
      ON wiki_pages(slug);

    CREATE INDEX IF NOT EXISTS idx_wiki_pages_project
      ON wiki_pages(project);

    CREATE INDEX IF NOT EXISTS idx_wiki_pages_status
      ON wiki_pages(status);

    CREATE INDEX IF NOT EXISTS idx_wiki_pages_page_type
      ON wiki_pages(page_type);

    CREATE INDEX IF NOT EXISTS idx_wiki_pages_parent
      ON wiki_pages(parent_id);

    CREATE INDEX IF NOT EXISTS idx_wiki_spaces_tenant
      ON wiki_spaces(tenant_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_page_permissions_role
      ON wiki_page_permissions(page_id, role);

    CREATE INDEX IF NOT EXISTS idx_wiki_page_permissions_page
      ON wiki_page_permissions(page_id);

    CREATE INDEX IF NOT EXISTS idx_wiki_page_versions_page
      ON wiki_page_versions(page_id);

    CREATE INDEX IF NOT EXISTS idx_wiki_cross_refs_source
      ON wiki_cross_references(source_page_id);

    CREATE INDEX IF NOT EXISTS idx_wiki_cross_refs_target
      ON wiki_cross_references(target_page_id);

    CREATE INDEX IF NOT EXISTS idx_wiki_contradictions_resolved
      ON wiki_contradictions(resolved);

    CREATE INDEX IF NOT EXISTS idx_content_sources_type
      ON content_sources(source_type);

    CREATE INDEX IF NOT EXISTS idx_content_sources_processed
      ON content_sources(processed);

    CREATE INDEX IF NOT EXISTS idx_rss_feeds_active
      ON rss_feeds(active);

    CREATE INDEX IF NOT EXISTS idx_rss_feeds_project
      ON rss_feeds(project);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(title, content, tags, content=memories, content_rowid=rowid);

    CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts
    USING fts5(title, content, summary, tags, content=wiki_pages, content_rowid=rowid);
  `);

  ensureColumn(db, "memories", "tenant_id", "TEXT");
  ensureColumn(db, "memories", "summary", "TEXT");
  ensureColumn(db, "audit_log", "tenant_id", "TEXT");
  ensureColumn(db, "performance_log", "avg_similarity", "REAL");
  ensureColumn(db, "performance_log", "tenant_id", "TEXT");
  ensureColumn(db, "performance_log", "result_types", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "performance_log", "bm25_result_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "wiki_pages", "space_id", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_tenant_status
      ON memories(tenant_id, status);

    CREATE INDEX IF NOT EXISTS idx_performance_log_tenant_timestamp
      ON performance_log(tenant_id, timestamp);

    CREATE INDEX IF NOT EXISTS idx_usage_log_tenant_month
      ON usage_log(tenant_id, month);

    CREATE INDEX IF NOT EXISTS idx_wiki_pages_space
      ON wiki_pages(space_id);

    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp
      ON audit_log(timestamp);

    CREATE INDEX IF NOT EXISTS idx_audit_log_action
      ON audit_log(action);

    CREATE INDEX IF NOT EXISTS idx_audit_log_actor
      ON audit_log(actor);

    CREATE INDEX IF NOT EXISTS idx_audit_log_tenant
      ON audit_log(tenant_id);
  `);
}
