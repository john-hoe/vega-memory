import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { ConsolidationReportEngine } from "../core/consolidation-report-engine.js";
import type { ConsolidationDetector } from "../core/consolidation-detector.js";
import type {
  ConsolidationCandidate,
  FactClaim,
  Memory,
  SessionStartMode,
  SessionStartResult,
  StoreParams,
  StoreResult
} from "../core/types.js";
import { Repository } from "../db/repository.js";
import { createMCPServer } from "../mcp/server.js";
import { CrossReferenceService } from "../wiki/cross-reference.js";
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
  telegramChatId: undefined
};

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
  created_at: "2026-04-06T00:00:00.000Z",
  updated_at: "2026-04-06T00:00:00.000Z",
  accessed_at: "2026-04-06T00:00:00.000Z",
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
  created_at: "2026-04-06T00:00:00.000Z",
  updated_at: "2026-04-06T00:00:00.000Z",
  ...overrides
});

const createServerHarness = (overrides: Partial<VegaConfig> = {}) => {
  const repository = new Repository(":memory:");
  const pageManager = new PageManager(repository);
  const crossReferenceService = new CrossReferenceService(pageManager);
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
    pageManager,
    crossReferenceService,
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

const createCandidate = (
  overrides: Partial<ConsolidationCandidate> = {}
): ConsolidationCandidate => ({
  kind: "duplicate_merge",
  action: "merge",
  risk: "low",
  memory_ids: ["memory-1"],
  fact_claim_ids: [],
  description: "Merge duplicate auth memories",
  evidence: ["content overlap > 0.95"],
  score: 0.92,
  ...overrides
});

test("report engine with no detectors produces an empty report", () => {
  const repository = new Repository(":memory:");
  const engine = new ConsolidationReportEngine(repository, baseConfig);

  try {
    const report = engine.generateReport("vega", "tenant-1");

    assert.equal(report.version, 1);
    assert.deepEqual(report.sections, []);
    assert.deepEqual(report.summary, {
      total_candidates: 0,
      low_risk: 0,
      medium_risk: 0,
      high_risk: 0
    });
    assert.equal(report.execution.project, "vega");
    assert.equal(report.execution.tenant_id, "tenant-1");
    assert.equal(report.execution.mode, "dry_run");
    assert.equal(typeof report.execution.run_id, "string");
    assert.deepEqual(report.execution.candidates_by_kind, {});
    assert.deepEqual(report.execution.errors, []);
  } finally {
    repository.close();
  }
});

test("report engine with a mock detector collects candidates", () => {
  const repository = new Repository(":memory:");
  const engine = new ConsolidationReportEngine(repository, baseConfig);
  const detector: ConsolidationDetector = {
    kind: "duplicate_merge",
    label: "Duplicate Merge Candidates",
    detect: () => [
      createCandidate(),
      createCandidate({
        memory_ids: ["memory-2", "memory-3"],
        description: "Merge duplicated cache notes",
        risk: "medium",
        score: 0.81
      })
    ]
  };

  engine.registerDetector(detector);

  try {
    const report = engine.generateReport("vega");

    assert.equal(report.sections.length, 1);
    assert.equal(report.sections[0]?.kind, "duplicate_merge");
    assert.equal(report.sections[0]?.label, "Duplicate Merge Candidates");
    assert.equal(report.sections[0]?.candidates.length, 2);
    assert.equal(report.execution.total_candidates, 2);
    assert.deepEqual(report.execution.candidates_by_kind, {
      duplicate_merge: 2
    });
    assert.deepEqual(report.summary, {
      total_candidates: 2,
      low_risk: 1,
      medium_risk: 1,
      high_risk: 0
    });
  } finally {
    repository.close();
  }
});

test("failing detector does not crash the engine", () => {
  const repository = new Repository(":memory:");
  const engine = new ConsolidationReportEngine(repository, baseConfig);

  engine.registerDetector({
    kind: "expired_fact",
    label: "Expired Fact Candidates",
    detect: () => {
      throw new Error("detector failed");
    }
  });
  engine.registerDetector({
    kind: "global_promotion",
    label: "Global Promotion Candidates",
    detect: () => [
      createCandidate({
        kind: "global_promotion",
        action: "promote_global",
        risk: "high",
        memory_ids: ["memory-4"],
        description: "Promote durable infrastructure guidance globally",
        score: 0.76
      })
    ]
  });

  try {
    const report = engine.generateReport("vega");

    assert.equal(report.sections.length, 1);
    assert.equal(report.sections[0]?.kind, "global_promotion");
    assert.equal(report.execution.total_candidates, 1);
    assert.equal(report.execution.errors.length, 1);
    assert.match(report.execution.errors[0] ?? "", /^expired_fact: detector failed$/);
  } finally {
    repository.close();
  }
});

test("execution log tracks timing and uses a UUID run id", () => {
  const repository = new Repository(":memory:");
  const engine = new ConsolidationReportEngine(repository, baseConfig);

  try {
    const report = engine.generateReport("vega");

    assert.ok(report.execution.duration_ms >= 0);
    assert.ok(report.execution.started_at < report.execution.completed_at);
    assert.match(
      report.execution.run_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  } finally {
    repository.close();
  }
});

test("consolidation_report MCP tool returns an error when the feature is disabled", async () => {
  const { server } = createServerHarness({
    features: {
      consolidationReport: false
    }
  });

  try {
    const result = await getRegisteredTools(server).consolidation_report.handler(
      {
        project: "vega"
      },
      {}
    );
    const payload = parseToolPayload<{ error: string }>(result);

    assert.equal(result.isError, true);
    assert.equal(payload.error, "consolidation_report feature is disabled");
  } finally {
    await server.close();
  }
});

test("consolidation_report MCP tool returns a report when the feature is enabled", async () => {
  const { repository, server } = createServerHarness({
    features: {
      consolidationReport: true
    }
  });

  try {
    repository.createMemory(createStoredMemory());
    repository.createFactClaim(createFactClaim());

    const result = await getRegisteredTools(server).consolidation_report.handler(
      {
        project: "vega",
        tenant_id: "tenant-1"
      },
      {}
    );
    const payload = parseToolPayload<{
      version: number;
      execution: {
        project: string;
        tenant_id: string | null;
        mode: string;
        total_candidates: number;
      };
      sections: unknown[];
      summary: {
        total_candidates: number;
      };
    }>(result);

    assert.equal(result.isError, undefined);
    assert.equal(payload.version, 1);
    assert.equal(payload.execution.project, "vega");
    assert.equal(payload.execution.tenant_id, "tenant-1");
    assert.equal(payload.execution.mode, "dry_run");
    assert.equal(payload.execution.total_candidates, 0);
    assert.equal(payload.sections.length, 5);
    assert.equal(payload.summary.total_candidates, 0);
  } finally {
    repository.close();
    await server.close();
  }
});
