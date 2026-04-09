import type { PgQueryExecutor } from "./pg-executor.js";

export interface TenantSchemaConfig {
  prefix: string;
  sharedSchema: string;
  defaultSchema: string;
}

const PG_VECTOR_DIMENSIONS = 1024;

function createTable(schemaName: string, tableName: string, body: string): string {
  return `CREATE TABLE IF NOT EXISTS ${schemaName}.${tableName} (\n${body}\n);`;
}

function createTextSearchIndex(
  schemaName: string,
  indexName: string,
  tableName: string,
  columns: string[]
): string {
  const document = columns
    .map((column) => `coalesce(${column}, '')`)
    .join(` || ' ' || `);

  return [
    `CREATE INDEX IF NOT EXISTS ${indexName}`,
    `ON ${schemaName}.${tableName}`,
    `USING GIN (to_tsvector('simple', ${document}));`
  ].join("\n");
}

function resolveTenantSchemaConfig(config: TenantSchemaConfig): TenantSchemaConfig {
  return {
    prefix: config.prefix || "tenant_",
    sharedSchema: config.sharedSchema || "shared",
    defaultSchema: config.defaultSchema || "public"
  };
}

export class TenantSchemaManager {
  constructor(
    private config: TenantSchemaConfig,
    private readonly executor?: PgQueryExecutor
  ) {
    this.config = resolveTenantSchemaConfig(config);
  }

  getSchemaName(tenantId: string): string {
    return `${this.config.prefix}${this.sanitizeTenantId(tenantId)}`;
  }

  getSharedSchemaName(): string {
    return this.config.sharedSchema;
  }

  getDefaultSchemaName(): string {
    return this.config.defaultSchema;
  }

  async createSchema(tenantId: string): Promise<void> {
    const schemaName = this.getSchemaName(tenantId);

    if (this.executor === undefined) {
      console.log(`Would create schema: ${schemaName}`);
      for (const statement of this.generateCreateDDL(tenantId)) {
        console.log(statement);
      }
      return;
    }

    for (const statement of this.generateCreateDDL(tenantId)) {
      await this.executor.query(statement);
    }
  }

  async dropSchema(tenantId: string): Promise<void> {
    const schemaName = this.getSchemaName(tenantId);

    if (this.executor === undefined) {
      console.log(`Would drop schema: ${schemaName}`);
      console.log(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
      return;
    }

    await this.executor.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
  }

  async migrateSchema(tenantId: string, version: number): Promise<void> {
    const schemaName = this.getSchemaName(tenantId);

    if (this.executor === undefined) {
      console.log(`Would migrate schema: ${schemaName} to version ${version}`);
      return;
    }

    await this.executor.query(
      [
        `CREATE TABLE IF NOT EXISTS ${schemaName}._schema_versions (`,
        "  version INTEGER NOT NULL,",
        "  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
        ");"
      ].join("\n")
    );
    await this.executor.query(
      `INSERT INTO ${schemaName}._schema_versions (version) VALUES ($1)`,
      [version]
    );
  }

  async listSchemas(): Promise<string[]> {
    if (this.executor === undefined) {
      console.log("Would list tenant schemas");
      return [];
    }

    const result = await this.executor.query<{ schema_name: string }>(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name LIKE $1
       ORDER BY schema_name ASC`,
      [`${this.config.prefix}%`]
    );

    return result.rows.map((row) => row.schema_name);
  }

  generateCreateDDL(tenantId: string): string[] {
    const schemaName = this.getSchemaName(tenantId);

    return [
      "CREATE EXTENSION IF NOT EXISTS vector;",
      `CREATE SCHEMA IF NOT EXISTS ${schemaName};`,
      createTable(
        schemaName,
        "memories",
        [
          "  id TEXT PRIMARY KEY,",
          "  tenant_id TEXT,",
          "  type TEXT NOT NULL,",
          "  project TEXT NOT NULL,",
          "  title TEXT NOT NULL,",
          "  content TEXT NOT NULL,",
          "  summary TEXT,",
          `  embedding vector(${PG_VECTOR_DIMENSIONS}),`,
          "  importance DOUBLE PRECISION NOT NULL,",
          "  source TEXT NOT NULL,",
          "  tags TEXT NOT NULL,",
          "  created_at TEXT NOT NULL,",
          "  updated_at TEXT NOT NULL,",
          "  accessed_at TEXT NOT NULL,",
          "  access_count INTEGER DEFAULT 0,",
          "  status TEXT DEFAULT 'active',",
          "  verified TEXT DEFAULT 'unverified',",
          "  scope TEXT DEFAULT 'project',",
          "  accessed_projects TEXT DEFAULT '[]'"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "memory_versions",
        [
          "  id TEXT PRIMARY KEY,",
          "  memory_id TEXT NOT NULL,",
          "  content TEXT NOT NULL,",
          `  embedding vector(${PG_VECTOR_DIMENSIONS}),`,
          "  importance DOUBLE PRECISION NOT NULL,",
          "  updated_at TEXT NOT NULL,",
          `  FOREIGN KEY (memory_id) REFERENCES ${schemaName}.memories(id) ON DELETE CASCADE`
        ].join("\n")
      ),
      createTable(
        schemaName,
        "sessions",
        [
          "  id TEXT PRIMARY KEY,",
          "  project TEXT NOT NULL,",
          "  summary TEXT NOT NULL,",
          "  started_at TEXT NOT NULL,",
          "  ended_at TEXT NOT NULL,",
          "  memories_created TEXT DEFAULT '[]'"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "audit_log",
        [
          "  id BIGSERIAL PRIMARY KEY,",
          "  timestamp TEXT NOT NULL,",
          "  actor TEXT NOT NULL,",
          "  action TEXT NOT NULL,",
          "  memory_id TEXT,",
          "  detail TEXT NOT NULL,",
          "  ip TEXT,",
          "  tenant_id TEXT"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "performance_log",
        [
          "  timestamp TEXT NOT NULL,",
          "  tenant_id TEXT,",
          "  operation TEXT NOT NULL,",
          "  latency_ms DOUBLE PRECISION NOT NULL,",
          "  memory_count INTEGER NOT NULL,",
          "  result_count INTEGER NOT NULL,",
          "  avg_similarity DOUBLE PRECISION,",
          "  result_types TEXT NOT NULL DEFAULT '[]',",
          "  bm25_result_count INTEGER NOT NULL DEFAULT 0"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "metadata",
        [
          "  key TEXT PRIMARY KEY,",
          "  value TEXT NOT NULL,",
          "  updated_at TEXT NOT NULL"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "teams",
        [
          "  id TEXT PRIMARY KEY,",
          "  name TEXT NOT NULL UNIQUE,",
          "  owner_id TEXT NOT NULL,",
          "  created_at TEXT NOT NULL"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "team_members",
        [
          "  team_id TEXT NOT NULL,",
          "  user_id TEXT NOT NULL,",
          "  role TEXT NOT NULL CHECK(role IN ('admin', 'member', 'readonly')),",
          "  joined_at TEXT NOT NULL,",
          "  PRIMARY KEY (team_id, user_id),",
          `  FOREIGN KEY (team_id) REFERENCES ${schemaName}.teams(id) ON DELETE CASCADE`
        ].join("\n")
      ),
      createTable(
        schemaName,
        "tenants",
        [
          "  id TEXT PRIMARY KEY,",
          "  name TEXT NOT NULL,",
          "  plan TEXT NOT NULL DEFAULT 'free',",
          "  api_key TEXT UNIQUE NOT NULL,",
          "  active INTEGER NOT NULL DEFAULT 1,",
          "  created_at TEXT NOT NULL,",
          "  memory_limit INTEGER NOT NULL DEFAULT 1000,",
          "  updated_at TEXT NOT NULL"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "users",
        [
          "  id TEXT PRIMARY KEY,",
          "  email TEXT NOT NULL UNIQUE,",
          "  name TEXT NOT NULL,",
          "  role TEXT NOT NULL,",
          "  tenant_id TEXT NOT NULL,",
          "  sso_provider TEXT,",
          "  sso_subject TEXT,",
          "  created_at TEXT NOT NULL"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "usage_log",
        [
          "  id BIGSERIAL PRIMARY KEY,",
          "  tenant_id TEXT,",
          "  month TEXT,",
          "  memory_count INTEGER DEFAULT 0,",
          "  api_calls INTEGER DEFAULT 0,",
          "  storage_bytes INTEGER DEFAULT 0,",
          "  updated_at TEXT,",
          "  metric TEXT,",
          "  amount DOUBLE PRECISION,",
          "  recorded_at TEXT"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "entities",
        [
          "  id TEXT PRIMARY KEY,",
          "  name TEXT UNIQUE,",
          "  type TEXT NOT NULL,",
          "  metadata TEXT NOT NULL DEFAULT '{}',",
          "  created_at TEXT NOT NULL"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "relations",
        [
          "  id TEXT PRIMARY KEY,",
          "  source_entity_id TEXT NOT NULL,",
          "  target_entity_id TEXT NOT NULL,",
          "  relation_type TEXT NOT NULL,",
          "  memory_id TEXT NOT NULL,",
          "  created_at TEXT NOT NULL,",
          "  UNIQUE(source_entity_id, target_entity_id, relation_type, memory_id),",
          `  FOREIGN KEY (source_entity_id) REFERENCES ${schemaName}.entities(id) ON DELETE CASCADE,`,
          `  FOREIGN KEY (target_entity_id) REFERENCES ${schemaName}.entities(id) ON DELETE CASCADE,`,
          `  FOREIGN KEY (memory_id) REFERENCES ${schemaName}.memories(id) ON DELETE CASCADE`
        ].join("\n")
      ),
      createTable(
        schemaName,
        "wiki_spaces",
        [
          "  id TEXT PRIMARY KEY,",
          "  name TEXT NOT NULL,",
          "  slug TEXT NOT NULL,",
          "  tenant_id TEXT NOT NULL,",
          "  visibility TEXT NOT NULL DEFAULT 'internal',",
          "  created_at TEXT NOT NULL,",
          "  UNIQUE(slug, tenant_id),",
          `  FOREIGN KEY (tenant_id) REFERENCES ${schemaName}.tenants(id) ON DELETE CASCADE`
        ].join("\n")
      ),
      createTable(
        schemaName,
        "wiki_pages",
        [
          "  id TEXT PRIMARY KEY,",
          "  slug TEXT UNIQUE NOT NULL,",
          "  title TEXT NOT NULL,",
          "  content TEXT NOT NULL,",
          "  summary TEXT NOT NULL,",
          "  page_type TEXT NOT NULL,",
          "  scope TEXT NOT NULL DEFAULT 'project',",
          "  project TEXT,",
          "  tags TEXT NOT NULL DEFAULT '[]',",
          "  source_memory_ids TEXT NOT NULL DEFAULT '[]',",
          `  embedding vector(${PG_VECTOR_DIMENSIONS}),`,
          "  status TEXT NOT NULL DEFAULT 'draft',",
          "  auto_generated INTEGER NOT NULL DEFAULT 1,",
          "  reviewed INTEGER NOT NULL DEFAULT 0,",
          "  version INTEGER NOT NULL DEFAULT 1,",
          "  space_id TEXT,",
          "  parent_id TEXT,",
          "  tenant_id TEXT,",
          "  sort_order INTEGER NOT NULL DEFAULT 0,",
          "  created_at TEXT NOT NULL,",
          "  updated_at TEXT NOT NULL,",
          "  reviewed_at TEXT,",
          "  published_at TEXT,",
          `  FOREIGN KEY (space_id) REFERENCES ${schemaName}.wiki_spaces(id) ON DELETE SET NULL,`,
          `  FOREIGN KEY (parent_id) REFERENCES ${schemaName}.wiki_pages(id) ON DELETE SET NULL`
        ].join("\n")
      ),
      createTable(
        schemaName,
        "wiki_page_permissions",
        [
          "  page_id TEXT NOT NULL,",
          "  user_id TEXT,",
          "  role TEXT,",
          "  level TEXT NOT NULL,",
          "  UNIQUE(page_id, user_id),",
          "  CHECK ((user_id IS NOT NULL AND role IS NULL) OR (user_id IS NULL AND role IS NOT NULL)),",
          `  FOREIGN KEY (page_id) REFERENCES ${schemaName}.wiki_pages(id) ON DELETE CASCADE`
        ].join("\n")
      ),
      createTable(
        schemaName,
        "wiki_page_versions",
        [
          "  id TEXT PRIMARY KEY,",
          "  page_id TEXT NOT NULL,",
          "  content TEXT NOT NULL,",
          "  summary TEXT NOT NULL,",
          "  version INTEGER NOT NULL,",
          "  change_reason TEXT NOT NULL,",
          "  created_at TEXT NOT NULL,",
          `  FOREIGN KEY (page_id) REFERENCES ${schemaName}.wiki_pages(id) ON DELETE CASCADE`
        ].join("\n")
      ),
      createTable(
        schemaName,
        "wiki_cross_references",
        [
          "  id TEXT PRIMARY KEY,",
          "  source_page_id TEXT NOT NULL,",
          "  target_page_id TEXT NOT NULL,",
          "  context TEXT NOT NULL,",
          "  auto_generated INTEGER NOT NULL DEFAULT 1,",
          "  created_at TEXT NOT NULL,",
          `  FOREIGN KEY (source_page_id) REFERENCES ${schemaName}.wiki_pages(id) ON DELETE CASCADE,`,
          `  FOREIGN KEY (target_page_id) REFERENCES ${schemaName}.wiki_pages(id) ON DELETE CASCADE,`,
          "  UNIQUE(source_page_id, target_page_id)"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "wiki_contradictions",
        [
          "  id TEXT PRIMARY KEY,",
          "  page_a_id TEXT NOT NULL,",
          "  page_b_id TEXT NOT NULL,",
          "  statement_a TEXT NOT NULL,",
          "  statement_b TEXT NOT NULL,",
          "  detected_at TEXT NOT NULL,",
          "  resolved INTEGER NOT NULL DEFAULT 0,",
          `  FOREIGN KEY (page_a_id) REFERENCES ${schemaName}.wiki_pages(id) ON DELETE CASCADE,`,
          `  FOREIGN KEY (page_b_id) REFERENCES ${schemaName}.wiki_pages(id) ON DELETE CASCADE`
        ].join("\n")
      ),
      createTable(
        schemaName,
        "wiki_comments",
        [
          "  id TEXT PRIMARY KEY,",
          "  page_id TEXT NOT NULL,",
          "  user_id TEXT NOT NULL,",
          "  content TEXT NOT NULL,",
          "  mentions TEXT NOT NULL DEFAULT '[]',",
          "  parent_comment_id TEXT,",
          "  created_at TEXT NOT NULL,",
          "  updated_at TEXT,",
          `  FOREIGN KEY (page_id) REFERENCES ${schemaName}.wiki_pages(id) ON DELETE CASCADE,`,
          `  FOREIGN KEY (user_id) REFERENCES ${schemaName}.users(id) ON DELETE CASCADE,`,
          `  FOREIGN KEY (parent_comment_id) REFERENCES ${schemaName}.wiki_comments(id) ON DELETE CASCADE`
        ].join("\n")
      ),
      createTable(
        schemaName,
        "wiki_notifications",
        [
          "  id TEXT PRIMARY KEY,",
          "  user_id TEXT NOT NULL,",
          "  type TEXT NOT NULL,",
          "  source_id TEXT NOT NULL,",
          "  message TEXT NOT NULL,",
          "  read INTEGER NOT NULL DEFAULT 0,",
          "  created_at TEXT NOT NULL,",
          `  FOREIGN KEY (user_id) REFERENCES ${schemaName}.users(id) ON DELETE CASCADE`
        ].join("\n")
      ),
      createTable(
        schemaName,
        "content_sources",
        [
          "  id TEXT PRIMARY KEY,",
          "  source_type TEXT NOT NULL,",
          "  url TEXT,",
          "  title TEXT NOT NULL,",
          "  raw_content TEXT NOT NULL,",
          "  extracted_at TEXT NOT NULL,",
          "  processed INTEGER NOT NULL DEFAULT 0,",
          "  project TEXT,",
          "  tags TEXT NOT NULL DEFAULT '[]'"
        ].join("\n")
      ),
      createTable(
        schemaName,
        "rss_feeds",
        [
          "  id TEXT PRIMARY KEY,",
          "  url TEXT UNIQUE NOT NULL,",
          "  title TEXT NOT NULL,",
          "  project TEXT,",
          "  last_polled_at TEXT,",
          "  last_entry_at TEXT,",
          "  active INTEGER NOT NULL DEFAULT 1,",
          "  created_at TEXT NOT NULL"
        ].join("\n")
      ),
      `CREATE INDEX IF NOT EXISTS idx_relations_source_entity ON ${schemaName}.relations(source_entity_id);`,
      `CREATE INDEX IF NOT EXISTS idx_relations_target_entity ON ${schemaName}.relations(target_entity_id);`,
      `CREATE INDEX IF NOT EXISTS idx_relations_memory ON ${schemaName}.relations(memory_id);`,
      `CREATE INDEX IF NOT EXISTS idx_team_members_team ON ${schemaName}.team_members(team_id);`,
      `CREATE INDEX IF NOT EXISTS idx_team_members_user ON ${schemaName}.team_members(user_id);`,
      `CREATE INDEX IF NOT EXISTS idx_tenants_active ON ${schemaName}.tenants(active);`,
      `CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON ${schemaName}.users(tenant_id);`,
      [
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_identity",
        `ON ${schemaName}.users(sso_provider, sso_subject)`,
        "WHERE sso_provider IS NOT NULL AND sso_subject IS NOT NULL;"
      ].join("\n"),
      `CREATE INDEX IF NOT EXISTS idx_wiki_pages_slug ON ${schemaName}.wiki_pages(slug);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_pages_project ON ${schemaName}.wiki_pages(project);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_pages_status ON ${schemaName}.wiki_pages(status);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_pages_page_type ON ${schemaName}.wiki_pages(page_type);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_pages_parent ON ${schemaName}.wiki_pages(parent_id);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_pages_tenant ON ${schemaName}.wiki_pages(tenant_id);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_spaces_tenant ON ${schemaName}.wiki_spaces(tenant_id);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_wiki_page_permissions_role ON ${schemaName}.wiki_page_permissions(page_id, role);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_page_permissions_page ON ${schemaName}.wiki_page_permissions(page_id);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_page_versions_page ON ${schemaName}.wiki_page_versions(page_id);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_cross_refs_source ON ${schemaName}.wiki_cross_references(source_page_id);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_cross_refs_target ON ${schemaName}.wiki_cross_references(target_page_id);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_contradictions_resolved ON ${schemaName}.wiki_contradictions(resolved);`,
      `CREATE INDEX IF NOT EXISTS idx_content_sources_type ON ${schemaName}.content_sources(source_type);`,
      `CREATE INDEX IF NOT EXISTS idx_content_sources_processed ON ${schemaName}.content_sources(processed);`,
      `CREATE INDEX IF NOT EXISTS idx_rss_feeds_active ON ${schemaName}.rss_feeds(active);`,
      `CREATE INDEX IF NOT EXISTS idx_rss_feeds_project ON ${schemaName}.rss_feeds(project);`,
      `CREATE INDEX IF NOT EXISTS idx_memories_tenant_status ON ${schemaName}.memories(tenant_id, status);`,
      `CREATE INDEX IF NOT EXISTS idx_performance_log_tenant_timestamp ON ${schemaName}.performance_log(tenant_id, timestamp);`,
      `CREATE INDEX IF NOT EXISTS idx_usage_log_tenant_month ON ${schemaName}.usage_log(tenant_id, month);`,
      `CREATE INDEX IF NOT EXISTS idx_usage_log_tenant_metric_recorded_at ON ${schemaName}.usage_log(tenant_id, metric, recorded_at);`,
      `CREATE INDEX IF NOT EXISTS idx_wiki_pages_space ON ${schemaName}.wiki_pages(space_id);`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON ${schemaName}.audit_log(timestamp);`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_action ON ${schemaName}.audit_log(action);`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON ${schemaName}.audit_log(actor);`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON ${schemaName}.audit_log(tenant_id);`,
      createTextSearchIndex(schemaName, "idx_memories_fts", "memories", ["title", "content", "tags"]),
      createTextSearchIndex(schemaName, "idx_wiki_pages_fts", "wiki_pages", ["title", "content", "summary", "tags"])
    ];
  }

  sanitizeTenantId(id: string): string {
    return id.toLowerCase().replace(/[^a-z0-9_]/g, "");
  }
}
