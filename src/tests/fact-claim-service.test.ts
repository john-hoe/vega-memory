import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { FactClaimService } from "../core/fact-claim-service.js";
import type { FactClaim, Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";

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

const now = "2026-04-09T00:00:00.000Z";

const createMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => {
  const { summary = null, ...rest } = overrides;

  return {
    id: "memory-1",
    tenant_id: null,
    type: "project_context",
    project: "vega",
    title: "Database fact source",
    content: "Vega Memory uses SQLite.",
    summary,
    embedding: null,
    importance: 0.8,
    source: "explicit",
    tags: ["database"],
    created_at: now,
    updated_at: now,
    accessed_at: now,
    status: "active",
    verified: "verified",
    scope: "project",
    accessed_projects: ["vega"],
    ...rest
  };
};

const createFactClaim = (overrides: Partial<FactClaim> = {}): FactClaim => ({
  id: "fact-1",
  tenant_id: null,
  project: "vega",
  source_memory_id: "memory-1",
  evidence_archive_id: null,
  canonical_key: "vega-memory|database|sqlite",
  subject: "vega-memory",
  predicate: "database",
  claim_value: "sqlite",
  claim_text: "Vega Memory uses SQLite.",
  source: "hot_memory",
  status: "active",
  confidence: 0.8,
  valid_from: "2026-04-01T00:00:00.000Z",
  valid_to: null,
  temporal_precision: "day",
  invalidation_reason: null,
  created_at: now,
  updated_at: now,
  ...overrides
});

test("FactClaimService extracts claims, marks superseded same-memory claims, and flags conflicts", async () => {
  const repository = new Repository(":memory:");

  try {
    repository.createMemory(createMemory());
    repository.createMemory(
      createMemory({
        id: "memory-2",
        title: "Conflicting fact source",
        content: "Vega Memory uses MySQL."
      })
    );
    repository.createFactClaim(createFactClaim());
    repository.createFactClaim(
      createFactClaim({
        id: "fact-2",
        source_memory_id: "memory-2",
        canonical_key: "vega-memory|database|mysql",
        claim_value: "mysql",
        claim_text: "Vega Memory uses MySQL."
      })
    );

    const service = new FactClaimService(repository, baseConfig, async () => [
      {
        subject: "vega-memory",
        predicate: "database",
        claim_value: "postgres",
        claim_text: "Vega Memory uses Postgres.",
        confidence: 0.6,
        valid_from: "2026-04-10T00:00:00.000Z",
        valid_to: null,
        temporal_precision: "day"
      }
    ]);

    const extracted = await service.extractClaims("memory-1");
    const oldClaim = repository.getFactClaim("fact-1");
    const conflictingClaim = repository.getFactClaim("fact-2");

    assert.equal(extracted.length, 1);
    assert.equal(extracted[0]?.status, "conflict");
    assert.equal(oldClaim?.status, "suspected_expired");
    assert.equal(
      oldClaim?.invalidation_reason,
      "Superseded by newer extraction from memory memory-1."
    );
    assert.equal(conflictingClaim?.status, "conflict");
  } finally {
    repository.close();
  }
});

test("FactClaimService enforces legal transitions and resolves conflicting siblings", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createMemory(createMemory());
    repository.createMemory(
      createMemory({
        id: "memory-2",
        title: "Second fact source"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-1",
        status: "conflict"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-2",
        source_memory_id: "memory-2",
        canonical_key: "vega-memory|database|postgres",
        claim_value: "postgres",
        claim_text: "Vega Memory uses Postgres.",
        status: "conflict"
      })
    );

    const service = new FactClaimService(repository, baseConfig);
    assert.throws(
      () => service.expireClaim("fact-1", "System should not resolve a conflict winner."),
      /Illegal fact claim transition: conflict -> expired \(system\)/
    );

    const resolved = service.resolveClaim("fact-1", "active");

    assert.equal(resolved.status, "active");
    assert.equal(repository.getFactClaim("fact-2")?.status, "expired");
  } finally {
    repository.close();
  }
});

test("FactClaimService asOfQuery honors suspected and conflict flags", () => {
  const repository = new Repository(":memory:");

  try {
    repository.createMemory(createMemory());
    repository.createMemory(
      createMemory({
        id: "memory-2"
      })
    );
    repository.createFactClaim(createFactClaim());
    repository.createFactClaim(
      createFactClaim({
        id: "fact-2",
        predicate: "deployment",
        canonical_key: "vega-memory|deployment|local",
        claim_value: "local",
        claim_text: "Vega Memory runs locally.",
        status: "suspected_expired"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-3",
        source_memory_id: "memory-2",
        canonical_key: "vega-memory|database|postgres",
        claim_value: "postgres",
        claim_text: "Vega Memory uses Postgres.",
        status: "conflict"
      })
    );

    const service = new FactClaimService(repository, baseConfig);
    const defaultQuery = service.asOfQuery("vega", "2026-04-09T00:00:00.000Z");
    const expandedQuery = service.asOfQuery(
      "vega",
      "2026-04-09T00:00:00.000Z",
      undefined,
      undefined,
      {
        include_suspected_expired: true,
        include_conflicts: true
      }
    );

    assert.deepEqual(
      defaultQuery.map((claim) => claim.id).sort(),
      ["fact-1"]
    );
    assert.deepEqual(
      expandedQuery.map((claim) => claim.id).sort(),
      ["fact-1", "fact-2", "fact-3"]
    );
  } finally {
    repository.close();
  }
});
