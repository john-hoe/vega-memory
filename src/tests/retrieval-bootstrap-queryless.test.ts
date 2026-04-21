import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { INTENT_REQUEST_SCHEMA, type IntentRequest } from "../core/contracts/intent.js";
import { ArchiveService } from "../core/archive-service.js";
import { FactClaimService } from "../core/fact-claim-service.js";
import { KnowledgeGraphService } from "../core/knowledge-graph.js";
import type { FactClaim, Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import {
  createArchiveSource,
  createFactClaimSource,
  createGraphSource,
  createPromotedMemorySource,
  createWikiSource,
  SourceRegistry
} from "../retrieval/sources/index.js";
import { PageManager } from "../wiki/page-manager.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  dbEncryption: false,
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "test-chat-model",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  features: {
    factClaims: true,
    rawArchive: true,
    topicRecall: false,
    deepRecall: true
  }
};

function createMemory(overrides: Partial<Omit<Memory, "access_count">> = {}): Omit<Memory, "access_count"> {
  const createdAt = overrides.created_at ?? "2026-04-20T00:00:00.000Z";
  const { summary = null, ...rest } = overrides;

  return {
    id: "memory-1",
    tenant_id: null,
    type: "project_context",
    project: "vega",
    title: "Memory title",
    content: "Memory content",
    summary,
    embedding: null,
    importance: 0.8,
    source: "explicit",
    tags: ["retrieval"],
    created_at: createdAt,
    updated_at: overrides.updated_at ?? createdAt,
    accessed_at: overrides.accessed_at ?? createdAt,
    status: "active",
    verified: "verified",
    scope: "project",
    accessed_projects: ["vega"],
    source_context: null,
    ...rest
  };
}

function createFactClaim(overrides: Partial<FactClaim> = {}): FactClaim {
  const createdAt = overrides.created_at ?? "2026-04-20T00:00:00.000Z";

  return {
    id: "fact-1",
    tenant_id: null,
    project: "vega",
    source_memory_id: "memory-1",
    evidence_archive_id: null,
    canonical_key: "vega|database|sqlite",
    subject: "vega",
    predicate: "database",
    claim_value: "sqlite",
    claim_text: "Vega uses SQLite.",
    source: "hot_memory",
    status: "active",
    confidence: 0.8,
    valid_from: "2026-04-01T00:00:00.000Z",
    valid_to: null,
    temporal_precision: "day",
    invalidation_reason: null,
    created_at: createdAt,
    updated_at: overrides.updated_at ?? createdAt,
    ...overrides
  };
}

function createRegistry(repository: Repository): SourceRegistry {
  const registry = new SourceRegistry();
  const factClaimService = new FactClaimService(repository, baseConfig);
  const graphService = new KnowledgeGraphService(repository);
  const archiveService = new ArchiveService(repository);

  registry.register(createPromotedMemorySource(repository));
  registry.register(createWikiSource(repository));
  registry.register(createFactClaimSource(factClaimService));
  registry.register(createGraphSource(graphService));
  registry.register(createArchiveSource(archiveService));

  return registry;
}

function createRequest(
  cwd: string,
  overrides: Partial<Omit<IntentRequest, "session_id" | "surface" | "project" | "cwd" | "mode" | "intent">> &
    Pick<IntentRequest, "intent">
): IntentRequest {
  const { intent, ...rest } = overrides;

  return INTENT_REQUEST_SCHEMA.parse({
    intent,
    mode: "L1",
    surface: "codex",
    session_id: "session-bootstrap",
    project: "vega",
    cwd,
    ...rest
  });
}

function countBundleRecords(response: ReturnType<RetrievalOrchestrator["resolve"]>): number {
  return response.bundle.sections.reduce((sum, section) => sum + section.records.length, 0);
}

function seedWikiPage(
  repository: Repository,
  pageManager: PageManager,
  input: {
    title: string;
    summary: string;
    content: string;
    created_at: string;
  }
): void {
  const page = pageManager.createPage({
    title: input.title,
    summary: input.summary,
    content: input.content,
    page_type: "reference",
    project: "vega",
    auto_generated: false
  });

  repository.db
    .prepare<[string, string, string]>(
      `UPDATE wiki_pages
       SET created_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(input.created_at, input.created_at, page.id);
}

function seedGraphMemory(
  repository: Repository,
  graphService: KnowledgeGraphService,
  input: {
    id: string;
    title: string;
    content: string;
    created_at: string;
  }
): void {
  repository.createMemory(
    createMemory({
      id: input.id,
      title: input.title,
      content: input.content,
      created_at: input.created_at,
      updated_at: input.created_at,
      accessed_at: input.created_at
    })
  );

  const source = repository.createEntity(`${input.id}-source`, "concept");
  const target = repository.createEntity(`${input.id}-target`, "concept");

  graphService.createRelation(source.id, target.id, "related_to", input.id, {
    confidence: 1,
    extraction_method: "EXTRACTED"
  });
}

test("bootstrap without query returns records from multiple sources", () => {
  const repository = new Repository(":memory:");
  const tempDir = mkdtempSync(join(tmpdir(), "vega-bootstrap-queryless-"));
  const pageManager = new PageManager(repository);
  const graphService = new KnowledgeGraphService(repository);

  try {
    repository.createMemory(
      createMemory({
        id: "mem-1",
        title: "Promoted memory one",
        content: "Bootstrap memory alpha",
        created_at: "2026-04-10T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createMemory({
        id: "mem-2",
        title: "Promoted memory two",
        content: "Bootstrap memory beta",
        created_at: "2026-04-11T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createMemory({
        id: "mem-3",
        title: "Promoted memory three",
        content: "Bootstrap memory gamma",
        created_at: "2026-04-12T00:00:00.000Z"
      })
    );

    seedWikiPage(repository, pageManager, {
      title: "Wiki page one",
      summary: "Wiki summary one",
      content: "Wiki content alpha",
      created_at: "2026-04-18T00:00:00.000Z"
    });
    seedWikiPage(repository, pageManager, {
      title: "Wiki page two",
      summary: "Wiki summary two",
      content: "Wiki content beta",
      created_at: "2026-04-19T00:00:00.000Z"
    });

    repository.createMemory(
      createMemory({
        id: "fact-memory",
        title: "Fact source",
        content: "Fact content",
        created_at: "2026-04-15T00:00:00.000Z"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-1",
        source_memory_id: "fact-memory",
        claim_text: "Vega uses SQLite for retrieval.",
        created_at: "2026-04-15T00:00:00.000Z"
      })
    );

    seedGraphMemory(repository, graphService, {
      id: "graph-memory",
      title: "Graph memory",
      content: "Graph relation content",
      created_at: "2026-04-17T00:00:00.000Z"
    });

    const archiveService = new ArchiveService(repository);
    archiveService.store("Archive alpha content", "document", "vega", {
      title: "Archive alpha"
    });
    archiveService.store("Archive beta content", "document", "vega", {
      title: "Archive beta"
    });
    repository.db
      .prepare<[string, string, string]>(
        `UPDATE raw_archives
         SET created_at = ?, updated_at = ?
         WHERE title = ?`
      )
      .run("2026-04-13T00:00:00.000Z", "2026-04-13T00:00:00.000Z", "Archive alpha");
    repository.db
      .prepare<[string, string, string]>(
        `UPDATE raw_archives
         SET created_at = ?, updated_at = ?
         WHERE title = ?`
      )
      .run("2026-04-14T00:00:00.000Z", "2026-04-14T00:00:00.000Z", "Archive beta");

    const response = new RetrievalOrchestrator({
      registry: createRegistry(repository)
    }).resolve(createRequest(tempDir, { intent: "bootstrap" }));

    assert.ok(countBundleRecords(response) > 0);
    assert.ok(response.bundle.sections.length > 1);
    assert.ok(response.bundle.sections.some((section) => section.source_kind === "wiki"));
    assert.ok(
      response.bundle.sections.some((section) => ["graph", "vega_memory", "fact_claim", "archive"].includes(section.source_kind))
    );
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bootstrap queryless ordering prefers newer promoted memories", () => {
  const repository = new Repository(":memory:");
  const tempDir = mkdtempSync(join(tmpdir(), "vega-bootstrap-ordering-"));

  try {
    repository.createMemory(
      createMemory({
        id: "oldest",
        title: "Oldest memory",
        content: "Oldest content",
        created_at: "2026-04-01T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createMemory({
        id: "middle",
        title: "Middle memory",
        content: "Middle content",
        created_at: "2026-04-08T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createMemory({
        id: "newest",
        title: "Newest memory",
        content: "Newest content",
        created_at: "2026-04-15T00:00:00.000Z"
      })
    );

    const response = new RetrievalOrchestrator({
      registry: createRegistry(repository)
    }).resolve(createRequest(tempDir, { intent: "bootstrap" }));

    const vegaMemorySection = response.bundle.sections.find((section) => section.source_kind === "vega_memory");
    const ids = vegaMemorySection?.records.map((record) => record.id) ?? [];

    assert.deepEqual(ids, ["newest", "middle", "oldest"]);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("lookup without query still returns an empty bundle", () => {
  const repository = new Repository(":memory:");
  const tempDir = mkdtempSync(join(tmpdir(), "vega-lookup-queryless-"));

  try {
    repository.createMemory(
      createMemory({
        id: "mem-lookup",
        title: "Lookup memory",
        content: "Lookup content",
        created_at: "2026-04-15T00:00:00.000Z"
      })
    );

    const response = new RetrievalOrchestrator({
      registry: createRegistry(repository)
    }).resolve(createRequest(tempDir, { intent: "lookup" }));

    assert.equal(countBundleRecords(response), 0);
    assert.deepEqual(response.bundle.sections, []);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bootstrap queryless keeps the bundle at or below the default top-k", () => {
  const repository = new Repository(":memory:");
  const tempDir = mkdtempSync(join(tmpdir(), "vega-bootstrap-limit-"));

  try {
    for (let index = 0; index < 20; index += 1) {
      repository.createMemory(
        createMemory({
          id: `mem-${index}`,
          title: `Memory ${index}`,
          content: `Memory content ${index}`,
          created_at: `2026-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
        })
      );
    }

    const response = new RetrievalOrchestrator({
      registry: createRegistry(repository)
    }).resolve(createRequest(tempDir, { intent: "bootstrap" }));

    assert.ok(countBundleRecords(response) <= 5);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bootstrap with a query keeps using the search path instead of queryless fallback", () => {
  const repository = new Repository(":memory:");
  const tempDir = mkdtempSync(join(tmpdir(), "vega-bootstrap-queryful-"));

  try {
    repository.createMemory(
      createMemory({
        id: "match-alpha",
        title: "Alpha match",
        content: "alpha token lives here",
        created_at: "2026-04-20T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createMemory({
        id: "nonmatch-1",
        title: "Nonmatch one",
        content: "beta token lives here",
        created_at: "2026-04-19T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createMemory({
        id: "nonmatch-2",
        title: "Nonmatch two",
        content: "gamma token lives here",
        created_at: "2026-04-18T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createMemory({
        id: "nonmatch-3",
        title: "Nonmatch three",
        content: "delta token lives here",
        created_at: "2026-04-17T00:00:00.000Z"
      })
    );

    const response = new RetrievalOrchestrator({
      registry: createRegistry(repository)
    }).resolve(
      createRequest(tempDir, {
        intent: "bootstrap",
        query: "alpha"
      })
    );

    const records = response.bundle.sections.flatMap((section) => section.records);

    assert.equal(records.length, 1);
    assert.deepEqual(records.map((record) => record.id), ["match-alpha"]);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
