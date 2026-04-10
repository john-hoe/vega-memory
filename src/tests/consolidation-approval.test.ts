import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { ConsolidationApprovalService } from "../core/consolidation-approval.js";
import { ConsolidationDashboardService } from "../core/consolidation-dashboard.js";
import { ConsolidationScheduler } from "../core/consolidation-scheduler.js";
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

const createEmbeddingBuffer = (values: number[]): Buffer =>
  Buffer.from(new Float32Array(values).buffer);

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

const createCandidate = (
  overrides: Partial<ConsolidationCandidate> = {}
): ConsolidationCandidate => ({
  kind: "duplicate_merge",
  action: "merge",
  risk: "medium",
  memory_ids: ["memory-1", "memory-2"],
  fact_claim_ids: [],
  description: "Merge duplicate auth memories",
  evidence: ["content overlap > 0.95"],
  score: 0.92,
  ...overrides
});

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

test("submit candidate creates pending approval item", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const item = approvalService.submitForApproval("run-1", createCandidate(), "vega");

    assert.equal(item.status, "pending");
    assert.equal(repository.getApprovalItem(item.id)?.status, "pending");
    assert.equal(item.run_id, "run-1");
  } finally {
    repository.close();
  }
});

test("list pending returns only pending items", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const first = approvalService.submitForApproval("run-1", createCandidate(), "vega");
    const second = approvalService.submitForApproval(
      "run-1",
      createCandidate({ memory_ids: ["memory-3", "memory-4"] }),
      "vega"
    );
    approvalService.submitForApproval(
      "run-1",
      createCandidate({ memory_ids: ["memory-5", "memory-6"] }),
      "vega"
    );

    approvalService.review({
      item_id: first.id,
      status: "approved",
      reviewed_by: "alice"
    });

    const pending = approvalService.listPending("vega");

    assert.equal(pending.length, 2);
    assert.equal(pending.every((item) => item.status === "pending"), true);
    assert.equal(pending.some((item) => item.id === second.id), true);
  } finally {
    repository.close();
  }
});

test("review updates status and records reviewer", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const item = approvalService.submitForApproval("run-1", createCandidate(), "vega");
    const reviewed = approvalService.review({
      item_id: item.id,
      status: "approved",
      reviewed_by: "admin",
      comment: "looks safe"
    });

    assert.equal(reviewed.status, "approved");
    assert.equal(repository.getApprovalItem(item.id)?.status, "approved");
    assert.equal(reviewed.reviewed_by, "admin");
    assert.equal(reviewed.review_comment, "looks safe");
    assert.equal(typeof reviewed.reviewed_at, "string");
  } finally {
    repository.close();
  }
});

test("reject updates status", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const item = approvalService.submitForApproval("run-1", createCandidate(), "vega");
    const reviewed = approvalService.review({
      item_id: item.id,
      status: "rejected",
      reviewed_by: "admin"
    });

    assert.equal(reviewed.status, "rejected");
  } finally {
    repository.close();
  }
});

test("medium/high risk candidates auto-submitted in non-dry-run modes", () => {
  const repository = new Repository(":memory:");
  const scheduler = new ConsolidationScheduler(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      consolidationAutoExecute: true,
      factClaims: true
    }
  });
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    repository.createMemory(createStoredMemory({ id: "memory-1" }));
    repository.createMemory(createStoredMemory({ id: "memory-2" }));
    repository.createFactClaim(
      createFactClaim({
        id: "fact-1",
        source_memory_id: "memory-1",
        valid_from: "2026-04-01T00:00:00.000Z"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-2",
        source_memory_id: "memory-2",
        valid_from: "2026-04-05T00:00:00.000Z"
      })
    );

    scheduler.run("vega", null, { mode: "auto_low_risk" });

    const pending = approvalService.listPending("vega");

    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.candidate_risk, "medium");
    assert.equal(pending[0]?.candidate_action, "mark_expired");
  } finally {
    repository.close();
  }
});

test("execute approved merge", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        title: "Auth cache v1",
        content: "Original auth cache note.",
        updated_at: "2026-04-09T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-2",
        title: "Auth cache v2",
        content: "Updated auth cache note.",
        updated_at: "2026-04-10T00:00:00.000Z"
      })
    );

    const item = approvalService.submitForApproval("run-1", createCandidate(), "vega");
    const reviewed = approvalService.review(
      {
        item_id: item.id,
        status: "approved",
        reviewed_by: "admin"
      },
      true
    );

    assert.equal(reviewed.status, "approved");
    assert.equal(repository.getApprovalItem(item.id)?.status, "approved");

    const older = repository.getMemory("memory-1");
    const newer = repository.getMemory("memory-2");

    assert.equal(older?.status, "archived");
    assert.equal(newer?.status, "active");
    assert.match(newer?.content ?? "", /Original auth cache note\./);
    assert.match(newer?.content ?? "", /Updated auth cache note\./);
  } finally {
    repository.close();
  }
});

test("auto_execute failure sets status to execution_failed", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const item = approvalService.submitForApproval(
      "run-1",
      createCandidate({
        memory_ids: ["missing-1", "missing-2"]
      }),
      "vega"
    );
    const reviewed = approvalService.review(
      {
        item_id: item.id,
        status: "approved",
        reviewed_by: "admin"
      },
      true
    );

    assert.equal(reviewed.status, "execution_failed");
    assert.equal(repository.getApprovalItem(item.id)?.status, "execution_failed");
    assert.match(reviewed.review_comment ?? "", /\[execution_failed:/);
  } finally {
    repository.close();
  }
});

test("retry on execution_failed succeeds", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const item = approvalService.submitForApproval(
      "run-1",
      createCandidate({
        memory_ids: ["memory-1", "memory-2"]
      }),
      "vega"
    );

    approvalService.review(
      {
        item_id: item.id,
        status: "approved",
        reviewed_by: "admin"
      },
      true
    );

    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        title: "Auth cache v1",
        content: "Original auth cache note.",
        updated_at: "2026-04-09T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "memory-2",
        title: "Auth cache v2",
        content: "Updated auth cache note.",
        updated_at: "2026-04-10T00:00:00.000Z"
      })
    );

    const retried = approvalService.retry(item.id, "retry-admin");

    assert.equal(retried.status, "approved");
    assert.equal(repository.getApprovalItem(item.id)?.status, "approved");
  } finally {
    repository.close();
  }
});

test("retry on execution_failed that fails again stays execution_failed", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const item = approvalService.submitForApproval(
      "run-1",
      createCandidate({
        memory_ids: ["missing-1", "missing-2"]
      }),
      "vega"
    );

    approvalService.review(
      {
        item_id: item.id,
        status: "approved",
        reviewed_by: "admin"
      },
      true
    );

    const retried = approvalService.retry(item.id, "retry-admin");

    assert.equal(retried.status, "execution_failed");
    assert.equal(repository.getApprovalItem(item.id)?.status, "execution_failed");
    assert.match(retried.review_comment ?? "", /\[execution_failed:/);
    assert.match(retried.review_comment ?? "", /\[retry_execution_failed by retry-admin/);
  } finally {
    repository.close();
  }
});

test("retry on non-execution_failed throws", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const item = approvalService.submitForApproval("run-1", createCandidate(), "vega");

    assert.throws(() => approvalService.retry(item.id, "retry-admin"), /only execution_failed items can be retried/);
  } finally {
    repository.close();
  }
});

test("audit records both original failure and retry", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const item = approvalService.submitForApproval(
      "run-1",
      createCandidate({
        memory_ids: ["missing-1", "missing-2"]
      }),
      "vega"
    );

    approvalService.review(
      {
        item_id: item.id,
        status: "approved",
        reviewed_by: "admin"
      },
      true
    );
    approvalService.retry(item.id, "retry-admin");

    const reviewEntries = repository.getAuditLog({
      action: "consolidation_approval_reviewed"
    });
    const retryEntries = repository.getAuditLog({
      action: "consolidation_approval_retried"
    });
    const reviewDetail = JSON.parse(reviewEntries[0]?.detail ?? "{}") as {
      execution?: { success?: boolean };
    };
    const retryDetail = JSON.parse(retryEntries[0]?.detail ?? "{}") as {
      success?: boolean;
      previous_status?: string;
    };

    assert.equal(reviewEntries.length, 1);
    assert.equal(retryEntries.length, 1);
    assert.equal(reviewDetail.execution?.success, false);
    assert.equal(retryDetail.previous_status, "execution_failed");
    assert.equal(retryDetail.success, false);
  } finally {
    repository.close();
  }
});

test("execute approved conflict resolution", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        verified: "conflict"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-1",
        status: "conflict",
        source_memory_id: "memory-1"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-2",
        status: "conflict",
        source_memory_id: "memory-1",
        claim_value: "postgresql"
      })
    );

    const item = approvalService.submitForApproval(
      "run-1",
      createCandidate({
        kind: "conflict_aggregation",
        action: "review_conflict",
        risk: "high",
        memory_ids: ["memory-1"],
        fact_claim_ids: ["fact-1", "fact-2"],
        description: "Resolve database conflict group"
      }),
      "vega"
    );

    approvalService.review(
      {
        item_id: item.id,
        status: "approved",
        reviewed_by: "admin"
      },
      true
    );

    assert.equal(repository.getFactClaim("fact-1")?.status, "expired");
    assert.equal(repository.getFactClaim("fact-2")?.status, "expired");
    assert.equal(repository.getMemory("memory-1")?.verified, "verified");
  } finally {
    repository.close();
  }
});

test("partial conflict resolution keeps memory as conflict", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        verified: "conflict"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-1",
        status: "conflict",
        source_memory_id: "memory-1"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-2",
        status: "conflict",
        source_memory_id: "memory-1",
        claim_value: "postgresql"
      })
    );

    const item = approvalService.submitForApproval(
      "run-1",
      createCandidate({
        kind: "conflict_aggregation",
        action: "review_conflict",
        risk: "high",
        memory_ids: ["memory-1"],
        fact_claim_ids: ["fact-1"],
        description: "Resolve one conflict claim"
      }),
      "vega"
    );

    const reviewed = approvalService.review(
      {
        item_id: item.id,
        status: "approved",
        reviewed_by: "admin"
      },
      true
    );

    assert.equal(reviewed.status, "approved");
    assert.equal(repository.getFactClaim("fact-1")?.status, "expired");
    assert.equal(repository.getFactClaim("fact-2")?.status, "conflict");
    assert.equal(repository.getMemory("memory-1")?.verified, "conflict");
  } finally {
    repository.close();
  }
});

test("full conflict resolution changes memory to verified", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-1",
        verified: "conflict"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-1",
        status: "conflict",
        source_memory_id: "memory-1"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-2",
        status: "conflict",
        source_memory_id: "memory-1",
        claim_value: "postgresql"
      })
    );

    const item = approvalService.submitForApproval(
      "run-1",
      createCandidate({
        kind: "conflict_aggregation",
        action: "review_conflict",
        risk: "high",
        memory_ids: ["memory-1"],
        fact_claim_ids: ["fact-1", "fact-2"],
        description: "Resolve conflict group"
      }),
      "vega"
    );

    const reviewed = approvalService.review(
      {
        item_id: item.id,
        status: "approved",
        reviewed_by: "admin"
      },
      true
    );

    assert.equal(reviewed.status, "approved");
    assert.equal(repository.getFactClaim("fact-1")?.status, "expired");
    assert.equal(repository.getFactClaim("fact-2")?.status, "expired");
    assert.equal(repository.getMemory("memory-1")?.verified, "verified");
  } finally {
    repository.close();
  }
});

test("dashboard includes approval stats", () => {
  const repository = new Repository(":memory:");
  const approvalService = new ConsolidationApprovalService(repository);
  const dashboardService = new ConsolidationDashboardService(repository, {
    ...baseConfig,
    features: {
      consolidationReport: true,
      factClaims: true
    }
  });

  try {
    const pending = approvalService.submitForApproval("run-1", createCandidate(), "vega");
    const approved = approvalService.submitForApproval(
      "run-1",
      createCandidate({ memory_ids: ["memory-3", "memory-4"] }),
      "vega"
    );
    const rejected = approvalService.submitForApproval(
      "run-1",
      createCandidate({ memory_ids: ["memory-5", "memory-6"] }),
      "vega"
    );

    approvalService.review({
      item_id: approved.id,
      status: "approved",
      reviewed_by: "alice"
    });
    approvalService.review({
      item_id: rejected.id,
      status: "rejected",
      reviewed_by: "bob"
    });

    const dashboard = dashboardService.generateDashboard("vega");

    assert.equal(dashboard.approval_stats.pending, 1);
    assert.equal(dashboard.approval_stats.approved_total, 1);
    assert.equal(dashboard.approval_stats.rejected_total, 1);
    assert.equal(repository.getApprovalItem(pending.id)?.status, "pending");
  } finally {
    repository.close();
  }
});

test("MCP tool lists approvals", async () => {
  const { repository, server } = createServerHarness({
    features: {
      consolidationReport: true
    }
  });
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    approvalService.submitForApproval("run-1", createCandidate(), "vega");
    approvalService.submitForApproval(
      "run-1",
      createCandidate({ memory_ids: ["memory-3", "memory-4"] }),
      "vega"
    );

    const result = await getRegisteredTools(server).consolidation_approvals_list.handler(
      {
        project: "vega"
      },
      {}
    );
    const payload = parseToolPayload<Array<{ id: string; status: string }>>(result);

    assert.equal(result.isError, undefined);
    assert.equal(payload.length, 2);
    assert.equal(payload.every((item) => item.status === "pending"), true);
  } finally {
    repository.close();
    await server.close();
  }
});

test("MCP tool reviews approval", async () => {
  const { repository, server } = createServerHarness({
    features: {
      consolidationReport: true
    }
  });
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const item = approvalService.submitForApproval("run-1", createCandidate(), "vega");

    const result = await getRegisteredTools(server).consolidation_approval_review.handler(
      {
        item_id: item.id,
        status: "approved",
        reviewed_by: "admin"
      },
      {}
    );
    const payload = parseToolPayload<{ id: string; status: string }>(result);

    assert.equal(result.isError, undefined);
    assert.equal(payload.status, "approved");
    assert.equal(repository.getApprovalItem(item.id)?.status, "approved");
  } finally {
    repository.close();
    await server.close();
  }
});

test("MCP lists execution_failed items", async () => {
  const { repository, server } = createServerHarness({
    features: {
      consolidationReport: true
    }
  });
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const failed = approvalService.submitForApproval("run-1", createCandidate(), "vega");
    const pending = approvalService.submitForApproval(
      "run-1",
      createCandidate({ memory_ids: ["memory-3", "memory-4"] }),
      "vega"
    );

    repository.updateApprovalItem(failed.id, {
      status: "execution_failed",
      reviewed_by: "admin",
      reviewed_at: now,
      review_comment: "[execution_failed: test]"
    });

    const result = await getRegisteredTools(server).consolidation_approvals_list.handler(
      {
        project: "vega",
        status: "execution_failed"
      },
      {}
    );
    const payload = parseToolPayload<Array<{ id: string; status: string }>>(result);

    assert.equal(result.isError, undefined);
    assert.equal(payload.length, 1);
    assert.equal(payload[0]?.id, failed.id);
    assert.equal(payload[0]?.status, "execution_failed");
    assert.equal(repository.getApprovalItem(pending.id)?.status, "pending");
  } finally {
    repository.close();
    await server.close();
  }
});

test("MCP lists approved_pending_execution items", async () => {
  const { repository, server } = createServerHarness({
    features: {
      consolidationReport: true
    }
  });
  const approvalService = new ConsolidationApprovalService(repository);

  try {
    const pendingExecution = approvalService.submitForApproval("run-1", createCandidate(), "vega");
    approvalService.submitForApproval(
      "run-1",
      createCandidate({ memory_ids: ["memory-3", "memory-4"] }),
      "vega"
    );

    repository.updateApprovalItem(pendingExecution.id, {
      status: "approved_pending_execution",
      reviewed_by: "admin",
      reviewed_at: now,
      review_comment: "retrying"
    });

    const result = await getRegisteredTools(server).consolidation_approvals_list.handler(
      {
        project: "vega",
        status: "approved_pending_execution"
      },
      {}
    );
    const payload = parseToolPayload<Array<{ id: string; status: string }>>(result);

    assert.equal(result.isError, undefined);
    assert.equal(payload.length, 1);
    assert.equal(payload[0]?.id, pendingExecution.id);
    assert.equal(payload[0]?.status, "approved_pending_execution");
  } finally {
    repository.close();
    await server.close();
  }
});
