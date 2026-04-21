import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import Database from "better-sqlite3-multiple-ciphers";

import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import type { FactClaim, Memory, RawArchive } from "../core/types.js";
import { CompactService } from "../core/compact.js";
import { applyCandidateMemoryMigration } from "../db/candidate-memory-migration.js";
import { Repository } from "../db/repository.js";
import { createCandidateRepository } from "../db/candidate-repository.js";
import { initializeDatabase } from "../db/schema.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { RAW_INBOX_TABLE } from "../ingestion/raw-inbox.js";
import { SearchEngine } from "../search/engine.js";
import { PageManager } from "../wiki/page-manager.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";

interface TableInfoRow {
  name: string;
}

interface SourceKindRow {
  source_kind: string | null;
}

type MemoryWithSourceKind = Memory & { source_kind?: string | null };
type FactClaimWithSourceKind = FactClaim & { source_kind?: string | null };
type RawArchiveWithSourceKind = RawArchive & { source_kind?: string | null };

interface UsageAckCountRow {
  total: number;
}

interface ApiHarness {
  baseUrl: string;
  homeDir: string;
  repository: Repository;
  cleanup(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
}

const now = "2026-04-21T12:00:00.000Z";
const STORE_SUPPORT_THRESHOLD = 4;
const STORE_SUPPORT_LABELS = [
  "candidate_memory:candidate_memories",
  "promoted_memory:memories",
  "wiki:wiki_pages",
  "fact_claim:fact_claims",
  "graph:relations",
  "archive:raw_archives"
] as const;
const CURRENT_MISSING_SOURCE_KIND_STORES = [] as const;
const CANONICAL_SOURCE_KINDS_BY_TABLE = {
  candidate_memories: "vega_memory",
  memories: "vega_memory",
  wiki_pages: "wiki",
  fact_claims: "fact_claim",
  relations: "graph",
  raw_archives: "archive"
} as const;

function createEnvelope(source_kind: HostEventEnvelopeV1["source_kind"], event_id: string): HostEventEnvelopeV1 {
  return {
    schema_version: "1.0",
    event_id,
    surface: "codex",
    session_id: `session-${event_id}`,
    thread_id: `thread-${event_id}`,
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    host_timestamp: now,
    role: "assistant",
    event_type: "message",
    payload: {
      text: `source_kind=${source_kind}`
    },
    safety: {
      redacted: false,
      categories: []
    },
    artifacts: [],
    source_kind
  };
}

function createMemory(overrides: Partial<MemoryWithSourceKind> = {}): MemoryWithSourceKind {
  return {
    id: "mem-source-kind",
    tenant_id: null,
    type: "decision",
    project: "vega-memory",
    title: "Source Kind Memory",
    content: "host memory source kind retrieval token",
    summary: null,
    embedding: null,
    importance: 0.9,
    source: "explicit",
    tags: ["source-kind"],
    created_at: now,
    updated_at: now,
    accessed_at: now,
    access_count: 0,
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega-memory"],
    source_context: null,
    ...overrides
  };
}

function createFactClaim(overrides: Partial<FactClaimWithSourceKind> = {}): FactClaimWithSourceKind {
  return {
    id: "fact-source-kind",
    tenant_id: null,
    project: "vega-memory",
    source_memory_id: "mem-source-kind",
    evidence_archive_id: null,
    canonical_key: "source-kind|supports|host_memory_file",
    subject: "source-kind",
    predicate: "supports",
    claim_value: "host_memory_file",
    claim_text: "source_kind can be host_memory_file.",
    source: "manual",
    status: "active",
    confidence: 0.9,
    valid_from: now,
    valid_to: null,
    temporal_precision: "exact",
    invalidation_reason: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function createRawArchive(overrides: Partial<RawArchiveWithSourceKind> = {}): RawArchiveWithSourceKind {
  return {
    id: "archive-source-kind",
    tenant_id: null,
    project: "vega-memory",
    source_memory_id: null,
    archive_type: "document",
    title: "Source Kind Archive",
    source_uri: null,
    content: "host memory source kind archived evidence",
    content_hash: "archive-source-kind-hash",
    metadata: {},
    captured_at: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function createApiHarness(
  prefix: string,
  hostMemoryContent = "source kind default host memory anchor"
): Promise<ApiHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  const homeDir = join(tempDir, "home");
  mkdirSync(homeDir, { recursive: true });
  writeHomeFile(
    homeDir,
    ".codex/AGENTS.md",
    `# Host Memory\n\n${hostMemoryContent}\n`
  );

  const config: VegaConfig = {
    dbPath: ":memory:",
    cacheDbPath: ":memory:",
    ollamaBaseUrl: "http://localhost:99999",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    shardingEnabled: false,
    backupRetentionDays: 7,
    apiPort: 0,
    apiKey: "source-kind-secret",
    mode: "server",
    serverUrl: undefined,
    telegramBotToken: undefined,
    telegramChatId: undefined,
    observerEnabled: false,
    dbEncryption: false
  };

  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);
  const compactService = new CompactService(repository, config);
  const server = createAPIServer(
    {
      repository,
      memoryService,
      recallService,
      sessionService,
      compactService
    },
    config,
    {
      homeDir
    }
  );
  const port = await server.start(0);
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    homeDir,
    repository,
    async cleanup(): Promise<void> {
      await server.stop();
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
    request(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);
      headers.set("authorization", "Bearer source-kind-secret");

      if (init?.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      return fetch(`${baseUrl}${path}`, {
        ...init,
        headers
      });
    }
  };
}

function writeHomeFile(homeDir: string, relativePath: string, content: string): string {
  const fullPath = join(homeDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

function tableHasSourceKind(repository: Repository, table: string): boolean {
  return repository.db
    .prepare<[], TableInfoRow>(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === "source_kind");
}

function readStoredSourceKind(repository: Repository, table: string, id: string, keyColumn = "id"): string | null {
  return (
    repository.db
      .prepare<[string], SourceKindRow>(`SELECT source_kind FROM ${table} WHERE ${keyColumn} = ? LIMIT 1`)
      .get(id)?.source_kind ?? null
  );
}

function readSqliteSourceKind(db: Database.Database, table: string, id: string, keyColumn = "id"): string | null {
  return (
    db
      .prepare<[string], SourceKindRow>(`SELECT source_kind FROM ${table} WHERE ${keyColumn} = ? LIMIT 1`)
      .get(id)?.source_kind ?? null
  );
}

function assertStoreSupportThreshold(
  supportingStores: string[],
  floor = STORE_SUPPORT_THRESHOLD,
  allStores: readonly string[] = STORE_SUPPORT_LABELS
): void {
  const missingStores = allStores.filter((store) => !supportingStores.includes(store));

  assert.ok(
    supportingStores.length >= floor,
    `expected >= ${floor} stores to support source_kind, got ${supportingStores.length}: [${supportingStores.join(",")}]; missing: [${missingStores.join(",")}]`
  );
}

test("raw_inbox preserves source_kind across multiple canonical values", async () => {
  const harness = await createApiHarness("vega-source-kind-raw-");

  try {
    const cases: Array<{ event_id: string; source_kind: HostEventEnvelopeV1["source_kind"] }> = [
      {
        event_id: "11111111-1111-4111-8111-111111111111",
        source_kind: "host_memory_file"
      },
      {
        event_id: "22222222-2222-4222-8222-222222222222",
        source_kind: "vega_memory"
      },
      {
        event_id: "33333333-3333-4333-8333-333333333333",
        source_kind: "wiki"
      }
    ];

    for (const testCase of cases) {
      const response = await harness.request("/ingest_event", {
        method: "POST",
        body: JSON.stringify(createEnvelope(testCase.source_kind, testCase.event_id))
      });

      assert.equal(response.status, 200);
      assert.equal((await readJson<{ staged_in: string }>(response)).staged_in, "raw_inbox");
      assert.equal(
        readStoredSourceKind(harness.repository, RAW_INBOX_TABLE, testCase.event_id, "event_id"),
        testCase.source_kind
      );
    }
  } finally {
    await harness.cleanup();
  }
});

test("schema migration backfills canonical source_kind values for legacy rows across all six stores", () => {
  const db = new Database(":memory:");

  try {
    db.exec(`
      CREATE TABLE candidate_memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        project TEXT,
        tags TEXT,
        metadata TEXT,
        extraction_source TEXT NOT NULL,
        extraction_confidence REAL,
        promotion_score REAL NOT NULL DEFAULT 0,
        visibility_gated INTEGER NOT NULL DEFAULT 1,
        candidate_state TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE memories (
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

      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE,
        type TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE relations (
        id TEXT PRIMARY KEY,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        extraction_method TEXT NOT NULL DEFAULT 'EXTRACTED',
        created_at TEXT NOT NULL,
        UNIQUE(source_entity_id, target_entity_id, relation_type, memory_id)
      );

      CREATE TABLE wiki_spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        tenant_id TEXT,
        visibility TEXT NOT NULL DEFAULT 'internal',
        created_at TEXT NOT NULL,
        UNIQUE(slug, tenant_id)
      );

      CREATE TABLE wiki_pages (
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
        UNIQUE(slug, tenant_id)
      );

      CREATE TABLE raw_archives (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        project TEXT NOT NULL,
        source_memory_id TEXT,
        archive_type TEXT NOT NULL,
        title TEXT NOT NULL,
        source_uri TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding BLOB,
        metadata TEXT NOT NULL DEFAULT '{}',
        captured_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE fact_claims (
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
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        temporal_precision TEXT NOT NULL DEFAULT 'unknown',
        invalidation_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.prepare(
      `INSERT INTO candidate_memories (
        id, content, type, project, tags, metadata, extraction_source, extraction_confidence,
        promotion_score, visibility_gated, candidate_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "candidate-backfill",
      "candidate backfill content",
      "decision",
      "vega-memory",
      "[]",
      "{}",
      "manual",
      null,
      0,
      1,
      "pending",
      1,
      1
    );
    db.prepare(
      `INSERT INTO memories (
        id, tenant_id, type, project, title, content, summary, embedding, importance, source,
        tags, created_at, updated_at, accessed_at, access_count, status, verified, scope,
        accessed_projects, source_context
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "memory-backfill",
      null,
      "decision",
      "vega-memory",
      "Memory Backfill",
      "memory backfill content",
      null,
      null,
      0.5,
      "explicit",
      "[]",
      now,
      now,
      now,
      0,
      "active",
      "unverified",
      "project",
      "[]",
      null
    );
    db.prepare(
      `INSERT INTO wiki_spaces (id, name, slug, tenant_id, visibility, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("wiki-space-backfill", "Backfill Space", "backfill-space", null, "internal", now);
    db.prepare(
      `INSERT INTO wiki_pages (
        id, slug, title, content, summary, page_type, scope, project, tags, source_memory_ids,
        embedding, status, auto_generated, reviewed, version, space_id, parent_id, tenant_id,
        sort_order, created_at, updated_at, reviewed_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "wiki-backfill",
      "wiki-backfill",
      "Wiki Backfill",
      "wiki content",
      "wiki summary",
      "reference",
      "project",
      "vega-memory",
      "[]",
      "[]",
      null,
      "draft",
      0,
      0,
      1,
      "wiki-space-backfill",
      null,
      null,
      0,
      now,
      now,
      null,
      null
    );
    db.prepare(
      `INSERT INTO raw_archives (
        id, tenant_id, project, source_memory_id, archive_type, title, source_uri, content,
        content_hash, embedding, metadata, captured_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "archive-backfill",
      null,
      "vega-memory",
      "memory-backfill",
      "document",
      "Archive Backfill",
      null,
      "archive content",
      "archive-backfill-hash",
      null,
      "{}",
      null,
      now,
      now
    );
    db.prepare(
      `INSERT INTO fact_claims (
        id, tenant_id, project, source_memory_id, evidence_archive_id, canonical_key, subject,
        predicate, claim_value, claim_text, source, status, confidence, valid_from, valid_to,
        temporal_precision, invalidation_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "fact-backfill",
      null,
      "vega-memory",
      "memory-backfill",
      null,
      "fact|backfill",
      "fact",
      "supports",
      "backfill",
      "fact backfill",
      "manual",
      "active",
      0.8,
      now,
      null,
      "exact",
      null,
      now,
      now
    );
    db.prepare(`INSERT INTO entities (id, name, type, metadata, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      "entity-source-backfill",
      "Backfill Source",
      "concept",
      "{}",
      now
    );
    db.prepare(`INSERT INTO entities (id, name, type, metadata, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      "entity-target-backfill",
      "Backfill Target",
      "concept",
      "{}",
      now
    );
    db.prepare(
      `INSERT INTO relations (
        id, source_entity_id, target_entity_id, relation_type, memory_id, confidence, extraction_method, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "relation-backfill",
      "entity-source-backfill",
      "entity-target-backfill",
      "related_to",
      "memory-backfill",
      0.9,
      "EXTRACTED",
      now
    );

    initializeDatabase(db);
    applyCandidateMemoryMigration(new SQLiteAdapter(db));

    assert.equal(readSqliteSourceKind(db, "candidate_memories", "candidate-backfill"), CANONICAL_SOURCE_KINDS_BY_TABLE.candidate_memories);
    assert.equal(readSqliteSourceKind(db, "memories", "memory-backfill"), CANONICAL_SOURCE_KINDS_BY_TABLE.memories);
    assert.equal(readSqliteSourceKind(db, "wiki_pages", "wiki-backfill"), CANONICAL_SOURCE_KINDS_BY_TABLE.wiki_pages);
    assert.equal(readSqliteSourceKind(db, "fact_claims", "fact-backfill"), CANONICAL_SOURCE_KINDS_BY_TABLE.fact_claims);
    assert.equal(readSqliteSourceKind(db, "relations", "memory-backfill", "memory_id"), CANONICAL_SOURCE_KINDS_BY_TABLE.relations);
    assert.equal(readSqliteSourceKind(db, "raw_archives", "archive-backfill"), CANONICAL_SOURCE_KINDS_BY_TABLE.raw_archives);
  } finally {
    db.close();
  }
});

test("storage layers preserve explicit source_kind across all six stores", (t) => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const candidateRepository = createCandidateRepository(repository.db);

  try {
    const promotedMemory = createMemory({
      source_kind: "host_memory_file"
    });
    repository.createMemory(promotedMemory);
    candidateRepository.create({
      id: "candidate-source-kind",
      content: "candidate source kind content",
      type: "decision",
      project: "vega-memory",
      tags: ["source-kind"],
      metadata: {},
      extraction_source: "manual",
      source_kind: "host_memory_file"
    } as Parameters<typeof candidateRepository.create>[0]);
    const wikiPage = pageManager.createPage({
      title: "Source Kind Wiki",
      content: "source kind wiki content",
      summary: "source kind wiki summary",
      page_type: "reference",
      project: "vega-memory",
      tags: ["source-kind"],
      source_memory_ids: [promotedMemory.id],
      auto_generated: false,
      source_kind: "host_memory_file"
    } as Parameters<PageManager["createPage"]>[0]);
    repository.createFactClaim(createFactClaim({
      source_kind: "host_memory_file"
    }));
    const graphMemory = createMemory({
      id: "graph-memory-source-kind",
      title: "Graph Source Kind Memory",
      content: "graph memory source kind content",
      source_kind: "host_memory_file"
    });
    repository.createMemory(graphMemory);
    const sourceEntity = repository.createEntity("Source Kind Graph", "concept");
    const targetEntity = repository.createEntity("Host Memory File", "tool");
    repository.createRelation(sourceEntity.id, targetEntity.id, "related_to", graphMemory.id, 1, "EXTRACTED", "host_memory_file");
    repository.createRawArchive(createRawArchive({
      source_kind: "host_memory_file"
    }));

    const stores = [
      {
        name: "candidate_memory",
        table: "candidate_memories",
        id: "candidate-source-kind",
        keyColumn: "id"
      },
      {
        name: "promoted_memory",
        table: "memories",
        id: promotedMemory.id,
        keyColumn: "id"
      },
      {
        name: "wiki",
        table: "wiki_pages",
        id: wikiPage.id,
        keyColumn: "id"
      },
      {
        name: "fact_claim",
        table: "fact_claims",
        id: "fact-source-kind",
        keyColumn: "id"
      },
      {
        name: "graph",
        table: "relations",
        id: graphMemory.id,
        keyColumn: "memory_id"
      },
      {
        name: "archive",
        table: "raw_archives",
        id: "archive-source-kind",
        keyColumn: "id"
      }
    ] as const;

    const supportingStores: string[] = [];

    for (const store of stores) {
      if (!tableHasSourceKind(repository, store.table)) {
        continue;
      }

      supportingStores.push(`${store.name}:${store.table}`);
      assert.equal(
        readStoredSourceKind(repository, store.table, store.id, store.keyColumn),
        "host_memory_file"
      );
    }

    t.diagnostic(`stores supporting source_kind=${supportingStores.length}`);
    t.diagnostic(`stores missing source_kind=${CURRENT_MISSING_SOURCE_KIND_STORES.join(", ") || "none"}`);
    assert.equal(stores.length, 6);
    assert.equal(
      supportingStores.length,
      stores.length - CURRENT_MISSING_SOURCE_KIND_STORES.length,
      `expected current schema support count to remain ${stores.length - CURRENT_MISSING_SOURCE_KIND_STORES.length}, got ${supportingStores.length}: [${supportingStores.join(",")}]; missing: [${CURRENT_MISSING_SOURCE_KIND_STORES.join(",")}]`
    );
  } finally {
    repository.close();
  }
});

test("store-support threshold hard-fails below 4", () => {
  const fourSupportingStores = [...STORE_SUPPORT_LABELS].slice(0, STORE_SUPPORT_THRESHOLD);

  assert.throws(() => assertStoreSupportThreshold([], STORE_SUPPORT_THRESHOLD, STORE_SUPPORT_LABELS));
  assert.throws(() =>
    assertStoreSupportThreshold(
      ["candidate_memory:candidate_memories"],
      STORE_SUPPORT_THRESHOLD,
      STORE_SUPPORT_LABELS
    )
  );
  assert.doesNotThrow(() =>
    assertStoreSupportThreshold(fourSupportingStores, STORE_SUPPORT_THRESHOLD, STORE_SUPPORT_LABELS)
  );
});

test("memory repository preserves a non-default source_kind on insert and readback", () => {
  const repository = new Repository(":memory:");

  try {
    const memory = createMemory({
      id: "mem-non-default-source-kind",
      source_kind: "host_memory_file"
    });

    repository.createMemory(memory);

    assert.equal(readStoredSourceKind(repository, "memories", memory.id), "host_memory_file");
    assert.equal(
      (repository.getMemory(memory.id) as MemoryWithSourceKind | null)?.source_kind,
      "host_memory_file"
    );
  } finally {
    repository.close();
  }
});

test("context.resolve bundle records preserve host_memory_file source_kind end-to-end", async () => {
  const harness = await createApiHarness(
    "vega-source-kind-resolve-",
    "source kind propagation retrieval anchor"
  );

  try {
    const response = await harness.request("/context_resolve", {
      method: "POST",
      body: JSON.stringify({
        intent: "lookup",
        mode: "L1",
        query: "source kind propagation retrieval anchor",
        surface: "codex",
        session_id: "session-source-kind-resolve",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory"
      })
    });

    assert.equal(response.status, 200);
    const payload = await readJson<{
      bundle: {
        sections: Array<{
          source_kind: string;
          records: Array<{ source_kind: string; provenance: { origin: string } }>;
        }>;
      };
    }>(response);
    const section = payload.bundle.sections.find((entry) => entry.source_kind === "host_memory_file");

    assert.ok(section);
    assert.equal(section.records.length > 0, true);
    assert.equal(section.records.every((record) => record.source_kind === "host_memory_file"), true);
    assert.equal(
      section.records.some((record) => record.provenance.origin.endsWith("/.codex/AGENTS.md")),
      true
    );
  } finally {
    await harness.cleanup();
  }
});

test("usage_ack accepts a checkpoint whose evidence came from host_memory_file retrieval", async () => {
  const harness = await createApiHarness("vega-source-kind-ack-", "source kind ack anchor");

  try {
    const resolveResponse = await harness.request("/context_resolve", {
      method: "POST",
      body: JSON.stringify({
        intent: "lookup",
        mode: "L1",
        query: "source kind ack anchor",
        surface: "codex",
        session_id: "session-source-kind-ack",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory"
      })
    });

    assert.equal(resolveResponse.status, 200);
    const resolved = await readJson<{
      checkpoint_id: string;
      bundle_digest: string;
      bundle: {
        sections: Array<{
          source_kind: string;
          records: Array<{ source_kind: string }>;
        }>;
      };
    }>(resolveResponse);
    const hostSection = resolved.bundle.sections.find((entry) => entry.source_kind === "host_memory_file");

    assert.ok(hostSection);
    assert.equal(hostSection.records.every((record) => record.source_kind === "host_memory_file"), true);

    const ackResponse = await harness.request("/usage_ack", {
      method: "POST",
      body: JSON.stringify({
        checkpoint_id: resolved.checkpoint_id,
        bundle_digest: resolved.bundle_digest,
        sufficiency: "sufficient",
        host_tier: "T2",
        evidence: "source_kind=host_memory_file",
        turn_elapsed_ms: 42
      })
    });

    assert.equal(ackResponse.status, 200);
    assert.deepEqual(await readJson<{ ack: boolean }>(ackResponse), { ack: true });
    assert.equal(
      harness.repository.db
        .prepare<[], UsageAckCountRow>("SELECT COUNT(*) AS total FROM usage_acks")
        .get()?.total,
      1
    );
  } finally {
    await harness.cleanup();
  }
});

test("usage_ack echoes unique source_kinds from supplied bundle sections", async () => {
  const harness = await createApiHarness("vega-source-kind-ack-echo-", "source kind ack echo anchor");

  try {
    const resolveResponse = await harness.request("/context_resolve", {
      method: "POST",
      body: JSON.stringify({
        intent: "lookup",
        mode: "L1",
        query: "source kind ack echo anchor",
        surface: "codex",
        session_id: "session-source-kind-ack-echo",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory"
      })
    });

    assert.equal(resolveResponse.status, 200);
    const resolved = await readJson<{
      checkpoint_id: string;
      bundle_digest: string;
    }>(resolveResponse);

    const ackResponse = await harness.request("/usage_ack", {
      method: "POST",
      body: JSON.stringify({
        checkpoint_id: resolved.checkpoint_id,
        bundle_digest: resolved.bundle_digest,
        sufficiency: "sufficient",
        host_tier: "T2",
        evidence: "source_kind echo",
        turn_elapsed_ms: 64,
        bundle_sections: [
          {
            source_kind: "host_memory_file",
            records: [
              {
                id: "host-record",
                source_kind: "host_memory_file",
                content: "host content",
                provenance: {
                  origin: "/tmp/host-memory.md",
                  retrieved_at: now
                }
              }
            ]
          },
          {
            source_kind: "wiki",
            records: [
              {
                id: "wiki-record",
                source_kind: "wiki",
                content: "wiki content",
                provenance: {
                  origin: "wiki://source-kind",
                  retrieved_at: now
                }
              }
            ]
          },
          {
            source_kind: "archive",
            records: [
              {
                id: "archive-record",
                source_kind: "archive",
                content: "archive content",
                provenance: {
                  origin: "archive://source-kind",
                  retrieved_at: now
                }
              }
            ]
          }
        ]
      })
    });

    assert.equal(ackResponse.status, 200);
    assert.deepEqual(
      await readJson<{ ack: boolean; echoed_source_kinds?: string[] }>(ackResponse),
      {
        ack: true,
        echoed_source_kinds: ["archive", "host_memory_file", "wiki"]
      }
    );
  } finally {
    await harness.cleanup();
  }
});

test("full ingest to host_memory_file retrieval to usage_ack chain keeps source_kind observable", async () => {
  const harness = await createApiHarness("vega-source-kind-chain-", "source kind full chain anchor");

  try {
    const envelope = createEnvelope(
      "host_memory_file",
      "44444444-4444-4444-8444-444444444444"
    );
    const ingestResponse = await harness.request("/ingest_event", {
      method: "POST",
      body: JSON.stringify(envelope)
    });

    assert.equal(ingestResponse.status, 200);
    assert.equal(
      readStoredSourceKind(harness.repository, RAW_INBOX_TABLE, envelope.event_id, "event_id"),
      "host_memory_file"
    );

    const resolveResponse = await harness.request("/context_resolve", {
      method: "POST",
      body: JSON.stringify({
        intent: "lookup",
        mode: "L1",
        query: "source kind full chain anchor",
        surface: "codex",
        session_id: envelope.session_id,
        project: envelope.project,
        cwd: envelope.cwd
      })
    });

    assert.equal(resolveResponse.status, 200);
    const resolved = await readJson<{
      checkpoint_id: string;
      bundle_digest: string;
      bundle: {
        sections: Array<{
          source_kind: string;
          records: Array<{ source_kind: string }>;
        }>;
      };
    }>(resolveResponse);
    const hostSection = resolved.bundle.sections.find((entry) => entry.source_kind === "host_memory_file");

    assert.ok(hostSection);
    assert.equal(hostSection.records.length > 0, true);
    assert.equal(hostSection.records.every((record) => record.source_kind === "host_memory_file"), true);

    const ackResponse = await harness.request("/usage_ack", {
      method: "POST",
      body: JSON.stringify({
        checkpoint_id: resolved.checkpoint_id,
        bundle_digest: resolved.bundle_digest,
        sufficiency: "sufficient",
        host_tier: "T2",
        evidence: `event_id=${envelope.event_id};source_kind=host_memory_file`,
        turn_elapsed_ms: 84
      })
    });

    assert.equal(ackResponse.status, 200);
    assert.deepEqual(await readJson<{ ack: boolean }>(ackResponse), { ack: true });
    assert.equal(
      harness.repository.db
        .prepare<[], UsageAckCountRow>("SELECT COUNT(*) AS total FROM usage_acks")
        .get()?.total,
      1
    );
  } finally {
    await harness.cleanup();
  }
});
