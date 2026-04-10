import type Database from "better-sqlite3-multiple-ciphers";

interface TableColumnRow {
  name: string;
  notnull: number;
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

const ensureNullableWikiSpaceTenant = (db: Database.Database): void => {
  const columns = db
    .prepare<[], TableColumnRow>("PRAGMA table_info(wiki_spaces)")
    .all();
  const tenantColumn = columns.find((column) => column.name === "tenant_id");

  if (!tenantColumn || tenantColumn.notnull === 0) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_spaces__migrated (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      tenant_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'internal',
      created_at TEXT NOT NULL,
      UNIQUE(slug, tenant_id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );

    INSERT INTO wiki_spaces__migrated (id, name, slug, tenant_id, visibility, created_at)
    SELECT id, name, slug, tenant_id, visibility, created_at
    FROM wiki_spaces;

    DROP TABLE wiki_spaces;
    ALTER TABLE wiki_spaces__migrated RENAME TO wiki_spaces;
  `);
  db.exec("PRAGMA foreign_keys = ON");
};

const ensureTenantScopedWikiPageSlug = (db: Database.Database): void => {
  const uniqueSlugIndex = db
    .prepare<[], { name: string; unique: number }>("PRAGMA index_list(wiki_pages)")
    .all()
    .find((index) => {
      if (index.unique !== 1) {
        return false;
      }

      const columns = db
        .prepare<[], { name: string }>(`PRAGMA index_info(${index.name})`)
        .all()
        .map((column) => column.name);

      return columns.length === 1 && columns[0] === "slug";
    });

  if (!uniqueSlugIndex) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_pages__migrated (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
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
      tenant_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_at TEXT,
      published_at TEXT,
      UNIQUE(slug, tenant_id),
      FOREIGN KEY (space_id) REFERENCES wiki_spaces(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_id) REFERENCES wiki_pages(id) ON DELETE SET NULL
    );

    INSERT INTO wiki_pages__migrated (
      id, slug, title, content, summary, page_type, scope, project, tags, source_memory_ids,
      embedding, status, auto_generated, reviewed, version, space_id, parent_id, tenant_id,
      sort_order, created_at, updated_at, reviewed_at, published_at
    )
    SELECT
      id, slug, title, content, summary, page_type, scope, project, tags, source_memory_ids,
      embedding, status, auto_generated, reviewed, version, space_id, parent_id, tenant_id,
      sort_order, created_at, updated_at, reviewed_at, published_at
    FROM wiki_pages;

    DROP TABLE wiki_pages;
    ALTER TABLE wiki_pages__migrated RENAME TO wiki_pages;
  `);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("INSERT INTO wiki_pages_fts(wiki_pages_fts) VALUES('rebuild')");
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
      accessed_projects TEXT DEFAULT '[]',
      source_context TEXT
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
      bm25_result_count INTEGER NOT NULL DEFAULT 0,
      mode TEXT,
      token_estimate REAL,
      token_budget REAL,
      token_budget_utilization REAL,
      top_k_inflation_ratio REAL,
      embedding_latency_ms REAL
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS consolidation_runs (
      run_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      tenant_id TEXT,
      trigger TEXT NOT NULL,
      mode TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      total_candidates INTEGER NOT NULL DEFAULT 0,
      actions_executed INTEGER NOT NULL DEFAULT 0,
      actions_skipped INTEGER NOT NULL DEFAULT 0,
      errors TEXT NOT NULL DEFAULT '[]',
      report_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS consolidation_approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      project TEXT NOT NULL,
      tenant_id TEXT,
      candidate_kind TEXT NOT NULL,
      candidate_action TEXT NOT NULL,
      candidate_risk TEXT NOT NULL,
      memory_ids TEXT NOT NULL DEFAULT '[]',
      fact_claim_ids TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      score REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_comment TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS graph_content_cache (
      kind TEXT NOT NULL CHECK(kind IN ('code', 'doc')),
      scope_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      last_indexed_at TEXT NOT NULL,
      entity_count INTEGER NOT NULL DEFAULT 0,
      memory_ids TEXT NOT NULL DEFAULT '[]',
      last_modified_ms REAL,
      PRIMARY KEY (kind, scope_key, file_path)
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
      month TEXT,
      memory_count INTEGER DEFAULT 0,
      api_calls INTEGER DEFAULT 0,
      storage_bytes INTEGER DEFAULT 0,
      updated_at TEXT,
      metric TEXT,
      amount REAL,
      recorded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      type TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1),
      extraction_method TEXT NOT NULL DEFAULT 'EXTRACTED' CHECK(extraction_method IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')),
      created_at TEXT NOT NULL,
      UNIQUE(source_entity_id, target_entity_id, relation_type, memory_id),
      FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
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
      tenant_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_at TEXT,
      published_at TEXT,
      UNIQUE(slug, tenant_id),
      FOREIGN KEY (space_id) REFERENCES wiki_spaces(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_id) REFERENCES wiki_pages(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS wiki_spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      tenant_id TEXT,
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

    CREATE TABLE IF NOT EXISTS raw_archives (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      project TEXT NOT NULL,
      source_memory_id TEXT,
      archive_type TEXT NOT NULL CHECK(archive_type IN (
        'transcript',
        'discussion',
        'design_debate',
        'chat_export',
        'tool_log',
        'document'
      )),
      title TEXT NOT NULL,
      source_uri TEXT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding BLOB,
      metadata TEXT NOT NULL DEFAULT '{}',
      captured_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS fact_claims (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      project TEXT NOT NULL,
      source_memory_id TEXT,
      evidence_archive_id TEXT,
      canonical_key TEXT NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      claim_value TEXT NOT NULL,
      claim_text TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('hot_memory', 'raw_archive', 'manual', 'mixed')),
      status TEXT NOT NULL CHECK(status IN ('active', 'expired', 'suspected_expired', 'conflict')),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      temporal_precision TEXT NOT NULL DEFAULT 'unknown' CHECK(temporal_precision IN (
        'exact',
        'day',
        'week',
        'month',
        'quarter',
        'unknown'
      )),
      invalidation_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (source_memory_id IS NOT NULL OR evidence_archive_id IS NOT NULL),
      CHECK (valid_to IS NULL OR valid_to >= valid_from),
      FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE RESTRICT,
      FOREIGN KEY (evidence_archive_id) REFERENCES raw_archives(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      project TEXT NOT NULL,
      topic_key TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'topic' CHECK(kind IN ('topic', 'room')),
      description TEXT,
      source TEXT NOT NULL CHECK(source IN ('auto', 'explicit')),
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'superseded')),
      supersedes_topic_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (supersedes_topic_id) REFERENCES topics(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS memory_topics (
      memory_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('auto', 'explicit')),
      confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'superseded')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, topic_id),
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE RESTRICT
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

    CREATE INDEX IF NOT EXISTS idx_graph_content_cache_scope
      ON graph_content_cache(kind, scope_key);

    CREATE INDEX IF NOT EXISTS idx_graph_content_cache_hash
      ON graph_content_cache(content_hash);

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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_archives_dedupe
      ON raw_archives(COALESCE(tenant_id, ''), content_hash);

    CREATE INDEX IF NOT EXISTS idx_raw_archives_project_type
      ON raw_archives(project, archive_type);

    CREATE INDEX IF NOT EXISTS idx_raw_archives_source_memory
      ON raw_archives(source_memory_id);

    CREATE INDEX IF NOT EXISTS idx_fact_claims_subject_predicate
      ON fact_claims(project, subject, predicate, status);

    CREATE INDEX IF NOT EXISTS idx_fact_claims_canonical_key
      ON fact_claims(project, canonical_key, status);

    CREATE INDEX IF NOT EXISTS idx_fact_claims_as_of
      ON fact_claims(project, status, valid_from, valid_to);

    CREATE INDEX IF NOT EXISTS idx_fact_claims_source_memory
      ON fact_claims(source_memory_id);

    CREATE INDEX IF NOT EXISTS idx_fact_claims_evidence_archive
      ON fact_claims(evidence_archive_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_tenant_key_version
      ON topics(COALESCE(tenant_id, ''), project, topic_key, version);

    CREATE INDEX IF NOT EXISTS idx_topics_project_state
      ON topics(project, state);

    CREATE INDEX IF NOT EXISTS idx_topics_key_state_project
      ON topics(topic_key, state, project);

    CREATE INDEX IF NOT EXISTS idx_memory_topics_topic
      ON memory_topics(topic_id);

    CREATE INDEX IF NOT EXISTS idx_memory_topics_topic_status
      ON memory_topics(topic_id, status);

    CREATE INDEX IF NOT EXISTS idx_memory_topics_memory_status
      ON memory_topics(memory_id, status);

    CREATE INDEX IF NOT EXISTS idx_rss_feeds_active
      ON rss_feeds(active);

    CREATE INDEX IF NOT EXISTS idx_rss_feeds_project
      ON rss_feeds(project);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(title, content, tags, content=memories, content_rowid=rowid);

    CREATE VIRTUAL TABLE IF NOT EXISTS raw_archives_fts
    USING fts5(title, content, metadata, content=raw_archives, content_rowid=rowid);

    CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts
    USING fts5(title, content, summary, tags, content=wiki_pages, content_rowid=rowid);
  `);

  ensureColumn(db, "memories", "tenant_id", "TEXT");
  ensureColumn(db, "memories", "summary", "TEXT");
  ensureColumn(db, "memories", "source_context", "TEXT");
  ensureColumn(db, "entities", "metadata", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(
    db,
    "relations",
    "confidence",
    "REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1)"
  );
  ensureColumn(
    db,
    "relations",
    "extraction_method",
    "TEXT NOT NULL DEFAULT 'EXTRACTED' CHECK(extraction_method IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS'))"
  );
  ensureColumn(db, "audit_log", "tenant_id", "TEXT");
  ensureColumn(db, "performance_log", "avg_similarity", "REAL");
  ensureColumn(db, "performance_log", "tenant_id", "TEXT");
  ensureColumn(db, "performance_log", "result_types", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "performance_log", "bm25_result_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "performance_log", "mode", "TEXT");
  ensureColumn(db, "performance_log", "token_estimate", "REAL");
  ensureColumn(db, "performance_log", "token_budget", "REAL");
  ensureColumn(db, "performance_log", "token_budget_utilization", "REAL");
  ensureColumn(db, "performance_log", "top_k_inflation_ratio", "REAL");
  ensureColumn(db, "performance_log", "embedding_latency_ms", "REAL");
  ensureColumn(db, "usage_log", "metric", "TEXT");
  ensureColumn(db, "usage_log", "amount", "REAL");
  ensureColumn(db, "usage_log", "recorded_at", "TEXT");
  ensureColumn(db, "raw_archives", "embedding", "BLOB");
  ensureColumn(db, "wiki_pages", "space_id", "TEXT");
  ensureColumn(db, "wiki_pages", "tenant_id", "TEXT");
  ensureColumn(
    db,
    "fact_claims",
    "temporal_precision",
    "TEXT NOT NULL DEFAULT 'unknown' CHECK(temporal_precision IN ('exact', 'day', 'week', 'month', 'quarter', 'unknown'))"
  );
  ensureNullableWikiSpaceTenant(db);
  ensureTenantScopedWikiPageSlug(db);
  db.exec(`
    UPDATE wiki_pages
    SET tenant_id = (
      SELECT wiki_spaces.tenant_id
      FROM wiki_spaces
      WHERE wiki_spaces.id = wiki_pages.space_id
    )
    WHERE tenant_id IS NULL
      AND space_id IS NOT NULL
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_tenant_status
      ON memories(tenant_id, status);

    CREATE INDEX IF NOT EXISTS idx_performance_log_tenant_timestamp
      ON performance_log(tenant_id, timestamp);

    CREATE INDEX IF NOT EXISTS idx_usage_log_tenant_month
      ON usage_log(tenant_id, month);

    CREATE INDEX IF NOT EXISTS idx_usage_log_tenant_metric_recorded_at
      ON usage_log(tenant_id, metric, recorded_at);

    CREATE INDEX IF NOT EXISTS idx_wiki_pages_space
      ON wiki_pages(space_id);

    CREATE INDEX IF NOT EXISTS idx_wiki_pages_tenant
      ON wiki_pages(tenant_id);

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
