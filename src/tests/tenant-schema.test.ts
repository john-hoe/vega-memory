import assert from "node:assert/strict";
import test from "node:test";

import { TenantRouter } from "../db/tenant-router.js";
import { TenantSchemaManager } from "../db/tenant-schema.js";

test("TenantSchemaManager generates schema names with defaults and sanitization", () => {
  const manager = new TenantSchemaManager({
    prefix: "",
    sharedSchema: "",
    defaultSchema: ""
  });

  assert.equal(manager.getSchemaName("Acme-Prod_42"), "tenant_acmeprod_42");
});

test("TenantSchemaManager sanitizeTenantId strips SQL injection characters", () => {
  const manager = new TenantSchemaManager({
    prefix: "tenant_",
    sharedSchema: "shared",
    defaultSchema: "public"
  });

  assert.equal(
    manager.sanitizeTenantId("Acme'; DROP SCHEMA public; --_42"),
    "acmedropschemapublic_42"
  );
  assert.match(manager.sanitizeTenantId("tenant_01"), /^[a-z0-9_]+$/);
});

test("TenantSchemaManager generateCreateDDL mirrors the tenant schema bootstrap", () => {
  const manager = new TenantSchemaManager({
    prefix: "tenant_",
    sharedSchema: "shared",
    defaultSchema: "public"
  });
  const ddl = manager.generateCreateDDL("Acme-01");
  const schemaName = "tenant_acme01";
  const tableNames = [
    "memories",
    "memory_versions",
    "sessions",
    "audit_log",
    "performance_log",
    "metadata",
    "teams",
    "team_members",
    "tenants",
    "users",
    "usage_log",
    "entities",
    "relations",
    "wiki_spaces",
    "wiki_pages",
    "wiki_page_permissions",
    "wiki_page_versions",
    "wiki_cross_references",
    "wiki_contradictions",
    "wiki_comments",
    "wiki_notifications",
    "content_sources",
    "rss_feeds"
  ];

  assert.equal(ddl[0], "CREATE EXTENSION IF NOT EXISTS vector;");
  assert.equal(ddl[1], `CREATE SCHEMA IF NOT EXISTS ${schemaName};`);

  for (const tableName of tableNames) {
    assert.equal(
      ddl.some((statement) => statement.includes(`CREATE TABLE IF NOT EXISTS ${schemaName}.${tableName}`)),
      true
    );
  }

  assert.equal(
    ddl.some((statement) => statement.includes(`FOREIGN KEY (memory_id) REFERENCES ${schemaName}.memories(id)`)),
    true
  );
  assert.equal(
    ddl.some((statement) => statement.includes(`embedding vector(1024)`)),
    true
  );
  assert.equal(
    ddl.some((statement) => statement.includes(`CREATE INDEX IF NOT EXISTS idx_memories_tenant_status ON ${schemaName}.memories`)),
    true
  );
  assert.equal(
    ddl.some((statement) => statement.includes(`CREATE INDEX IF NOT EXISTS idx_memories_fts`) && statement.includes(`ON ${schemaName}.memories`)),
    true
  );
});

test("TenantRouter formats search_path with tenant, shared, and default schemas", () => {
  const manager = new TenantSchemaManager({
    prefix: "org_",
    sharedSchema: "shared_core",
    defaultSchema: "base"
  });
  const router = new TenantRouter(manager);

  assert.equal(
    router.getSearchPath("Acme-01"),
    'SET LOCAL search_path TO "org_acme01", "shared_core", "base"'
  );
});

test("TenantSchemaManager executes schema operations through a query executor", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const manager = new TenantSchemaManager(
    {
      prefix: "tenant_",
      sharedSchema: "shared",
      defaultSchema: "public"
    },
    {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        calls.push({ sql, params });
        if (sql.includes("information_schema.schemata")) {
          return {
            rows: [{ schema_name: "tenant_acme01" }] as T[]
          };
        }

        return {
          rows: [] as T[]
        };
      }
    }
  );

  await manager.createSchema("Acme-01");
  await manager.migrateSchema("Acme-01", 3);
  const schemas = await manager.listSchemas();
  await manager.dropSchema("Acme-01");

  assert.deepEqual(schemas, ["tenant_acme01"]);
  assert.ok(calls.some((call) => call.sql.includes("CREATE EXTENSION IF NOT EXISTS vector;")));
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO tenant_acme01._schema_versions")));
  assert.deepEqual(
    calls.find((call) => call.sql.includes("INSERT INTO tenant_acme01._schema_versions"))?.params,
    [3]
  );
  assert.ok(calls.some((call) => call.sql.includes("DROP SCHEMA IF EXISTS tenant_acme01 CASCADE;")));
});
