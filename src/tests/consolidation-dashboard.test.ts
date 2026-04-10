import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { ConsolidationDashboardService } from "../core/consolidation-dashboard.js";
import type {
  ConsolidationDashboardMetrics,
  FactClaim,
  Memory,
  MemoryTopic,
  SessionStartMode,
  SessionStartResult,
  StoreParams,
  StoreResult,
  Topic
} from "../core/types.js";
import { Repository } from "../db/repository.js";
import { createMCPServer } from "../mcp/server.js";

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
  telegramChatId: undefined
};

const now = "2026-04-10T00:00:00.000Z";

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  tenant_id: null,
  type: "insight",
  project: "vega",
  title: "Auth memory",
  content: "Auth configuration changed for the consolidation pipeline.",
  summary: null,
  embedding: null,
  importance: 0.8,
  source: "explicit",
  tags: ["auth"],
  created_at: now,
  updated_at: now,
  accessed_at: now,
  status: "active",
  verified: "unverified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

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

const createTopic = (overrides: Partial<Topic> = {}): Topic => ({
  id: "topic-1",
  tenant_id: null,
  project: "vega",
  topic_key: "auth",
  version: 1,
  label: "Auth",
  kind: "topic",
  description: null,
  source: "explicit",
  state: "active",
  supersedes_topic_id: null,
  created_at: now,
  updated_at: now,
  ...overrides
});

const createMemoryTopic = (overrides: Partial<MemoryTopic> = {}): MemoryTopic => ({
  memory_id: "memory-1",
  topic_id: "topic-1",
  source: "explicit",
  confidence: 1,
  status: "active",
  created_at: now,
  updated_at: now,
  ...overrides
});

const createEmbeddingBuffer = (values: number[]): Buffer =>
  Buffer.from(new Float32Array(values).buffer);

const createServerHarness = (overrides: Partial<VegaConfig> = {}) => {
  const repository = new Repository(":memory:");
  const server = createMCPServer({
    repository,
    graphService: {
      query: () => ({ entity: null, relations: [], memories: [] }),
      getNeighbors: () => ({ entity: null, neighbors: [], relations: [], memories: [] }),
      shortestPath: () => ({
        from: null,
        to: null,
        entities: [],
        relations: [],
        memories: [],
        found: false
      }),
      graphStats: () => ({
        total_entities: 0,
        total_relations: 0,
        entity_types: {},
        relation_types: {},
        average_confidence: null,
        tracked_code_files: 0,
        tracked_doc_files: 0
      }),
      subgraph: () => ({
        seed_entities: [],
        missing_entities: [],
        entities: [],
        relations: [],
        memories: []
      })
    },
    memoryService: {
      store: async (_params: StoreParams): Promise<StoreResult> => ({
        id: "noop",
        action: "created",
        title: "noop"
      }),
      update: async () => {},
      delete: async () => {}
    },
    recallService: {
      recall: async () => [],
      listMemories: () => []
    },
    sessionService: {
      sessionStart: async (
        _workingDirectory: string,
        _taskHint?: string,
        _tenantId?: string | null,
        _mode?: SessionStartMode
      ): Promise<SessionStartResult> => ({
        project: "vega",
        active_tasks: [],
        preferences: [],
        context: [],
        relevant: [],
        relevant_wiki_pages: [],
        wiki_drafts_pending: 0,
        recent_unverified: [],
        conflicts: [],
        proactive_warnings: [],
        token_estimate: 0
      }),
      sessionEnd: async () => {}
    },
    compactService: {
      compact: () => ({ merged: 0, archived: 0 })
    },
    config: {
      ...baseConfig,
      ...overrides
    }
  });

  return {
    repository,
    server
  };
};

const getRegisteredTools = (
  server: ReturnType<typeof createMCPServer>
): Record<
  string,
  {
    handler: (
      args: Record<string, unknown>,
      extra: object
    ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
  }
> =>
  (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
            extra: object
          ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
        }
      >;
    }
  )._registeredTools;

const parseToolPayload = <T>(result: {
  content: Array<{ text?: string }>;
}): T => JSON.parse(result.content[0]?.text ?? "{}") as T;

test("ConsolidationDashboardService returns correct memory stats", () => {
  const repository = new Repository(":memory:");
  const service = new ConsolidationDashboardService(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      factClaims: true
    }
  });

  try {
    repository.createMemory(createStoredMemory({ id: "active-project", type: "insight" }));
    repository.createMemory(
      createStoredMemory({
        id: "active-global",
        type: "decision",
        scope: "global"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "archived-memory",
        type: "pitfall",
        status: "archived"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "conflict-memory",
        type: "preference",
        verified: "conflict"
      })
    );

    const dashboard = service.generateDashboard("vega");

    assert.equal(dashboard.memory_stats.total_active, 3);
    assert.equal(dashboard.memory_stats.total_archived, 1);
    assert.equal(dashboard.memory_stats.by_type.insight, 1);
    assert.equal(dashboard.memory_stats.by_type.decision, 1);
    assert.equal(dashboard.memory_stats.by_type.preference, 1);
    assert.deepEqual(dashboard.memory_stats.by_scope, {
      project: 2,
      global: 1
    });
    assert.equal(dashboard.memory_stats.conflict_count, 1);
  } finally {
    repository.close();
  }
});

test("ConsolidationDashboardService returns fact claim stats", () => {
  const repository = new Repository(":memory:");
  const service = new ConsolidationDashboardService(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      factClaims: true
    }
  });

  try {
    repository.createMemory(createStoredMemory({ id: "memory-1" }));
    repository.createFactClaim(createFactClaim({ id: "active-claim", status: "active" }));
    repository.createFactClaim(createFactClaim({ id: "expired-claim", status: "expired" }));
    repository.createFactClaim(
      createFactClaim({
        id: "suspected-claim",
        status: "suspected_expired"
      })
    );
    repository.createFactClaim(createFactClaim({ id: "conflict-claim", status: "conflict" }));

    const dashboard = service.generateDashboard("vega");

    assert.deepEqual(dashboard.fact_claim_stats, {
      total_active: 1,
      expired: 1,
      suspected_expired: 1,
      conflict: 1
    });
  } finally {
    repository.close();
  }
});

test("ConsolidationDashboardService health indicators reflect actual data", () => {
  const repository = new Repository(":memory:");
  const service = new ConsolidationDashboardService(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      factClaims: true
    }
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "dup-1",
        title: "Auth cache decision",
        type: "insight",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.4]),
        accessed_projects: ["vega", "proj-b"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "dup-2",
        title: "Auth cache design",
        type: "insight",
        embedding: createEmbeddingBuffer([0.1, 0.2, 0.3, 0.41])
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "promotion-1",
        type: "pitfall",
        accessed_projects: ["vega", "proj-b"]
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "conflict-memory",
        verified: "conflict"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        title: "Fact source memory"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "expired-claim",
        valid_to: "2026-04-01T00:00:00.000Z"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "conflict-claim",
        status: "conflict"
      })
    );

    const dashboard = service.generateDashboard("vega");

    assert.ok(dashboard.health_indicators.duplicate_density > 0);
    assert.ok(dashboard.health_indicators.stale_fact_ratio > 0);
    assert.equal(dashboard.health_indicators.conflict_backlog, 2);
    assert.ok(dashboard.health_indicators.global_promotion_pending > 0);
  } finally {
    repository.close();
  }
});

test("ConsolidationDashboardService returns topic stats", () => {
  const repository = new Repository(":memory:");
  const service = new ConsolidationDashboardService(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      factClaims: true
    }
  });

  try {
    repository.createTopic(createTopic({ id: "topic-auth", topic_key: "auth" }));
    repository.createTopic(createTopic({ id: "topic-cache", topic_key: "cache" }));
    repository.createMemory(createStoredMemory({ id: "topic-memory-1" }));
    repository.createMemory(createStoredMemory({ id: "topic-memory-2" }));
    repository.createMemoryTopic(
      createMemoryTopic({
        memory_id: "topic-memory-1",
        topic_id: "topic-auth"
      })
    );
    repository.createMemoryTopic(
      createMemoryTopic({
        memory_id: "topic-memory-2",
        topic_id: "topic-auth"
      })
    );

    const dashboard = service.generateDashboard("vega");

    assert.deepEqual(dashboard.topic_stats, {
      total_topics: 2,
      topics_with_memories: 1,
      avg_memories_per_topic: 1
    });
  } finally {
    repository.close();
  }
});

test("consolidation_dashboard MCP tool returns dashboard metrics", async () => {
  const { repository, server } = createServerHarness({
    features: {
      consolidationReport: true,
      factClaims: true
    }
  });

  try {
    repository.createMemory(createStoredMemory({ id: "memory-1" }));
    repository.createFactClaim(createFactClaim({ id: "fact-1" }));

    const result = await getRegisteredTools(server).consolidation_dashboard.handler(
      {
        project: "vega"
      },
      {}
    );
    const payload = parseToolPayload<ConsolidationDashboardMetrics>(result);

    assert.equal(result.isError, undefined);
    assert.equal(payload.project, "vega");
    assert.equal(payload.memory_stats.total_active, 1);
    assert.equal(payload.fact_claim_stats.total_active, 1);
    assert.equal(typeof payload.generated_at, "string");
  } finally {
    repository.close();
    await server.close();
  }
});
