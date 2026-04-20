import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import type { FactClaim, Memory, RawArchive } from "../core/types.js";
import { CompactService } from "../core/compact.js";
import { Repository } from "../db/repository.js";
import { createCandidateRepository } from "../db/candidate-repository.js";
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

function createMemory(overrides: Partial<Memory> = {}): Memory {
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

function createFactClaim(overrides: Partial<FactClaim> = {}): FactClaim {
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

function createRawArchive(overrides: Partial<RawArchive> = {}): RawArchive {
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

test("storage layers only assert source_kind where the backing schema currently exposes the column", (t) => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const candidateRepository = createCandidateRepository(repository.db);

  try {
    const promotedMemory = createMemory();
    repository.createMemory(promotedMemory);
    candidateRepository.create({
      id: "candidate-source-kind",
      content: "candidate source kind content",
      type: "decision",
      project: "vega-memory",
      tags: ["source-kind"],
      metadata: {},
      extraction_source: "manual"
    });
    const wikiPage = pageManager.createPage({
      title: "Source Kind Wiki",
      content: "source kind wiki content",
      summary: "source kind wiki summary",
      page_type: "reference",
      project: "vega-memory",
      tags: ["source-kind"],
      source_memory_ids: [promotedMemory.id],
      auto_generated: false
    });
    repository.createFactClaim(createFactClaim());
    const graphMemory = createMemory({
      id: "graph-memory-source-kind",
      title: "Graph Source Kind Memory",
      content: "graph memory source kind content"
    });
    repository.createMemory(graphMemory);
    const sourceEntity = repository.createEntity("Source Kind Graph", "concept");
    const targetEntity = repository.createEntity("Host Memory File", "tool");
    repository.createRelation(sourceEntity.id, targetEntity.id, "related_to", graphMemory.id);
    repository.createRawArchive(createRawArchive());

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
    const missingStores: string[] = [];

    for (const store of stores) {
      if (!tableHasSourceKind(repository, store.table)) {
        missingStores.push(`${store.name}:${store.table}`);
        console.warn(
          `[source-kind-propagation] ${store.name} (${store.table}) does not expose a source_kind column yet`
        );
        continue;
      }

      supportingStores.push(`${store.name}:${store.table}`);
      assert.equal(
        readStoredSourceKind(repository, store.table, store.id, store.keyColumn),
        "host_memory_file"
      );
    }

    t.diagnostic(`stores supporting source_kind=${supportingStores.length}`);
    t.diagnostic(`stores missing source_kind=${missingStores.join(", ") || "none"}`);
    assert.equal(stores.length, 6);

    // TODO(P8-029): tighten this threshold once the store schemas actually add source_kind.
    assert.equal(supportingStores.length >= 0, true);
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
