import { appendFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AlertScheduler,
  DEFAULT_ALERT_CHANNELS_PATH,
  DEFAULT_ALERT_RULES_PATH,
  evaluateAlertRules,
  inspectAlertChannels,
  inspectAlertRules,
  loadAlertChannels,
  loadAlertRules,
  type AlertEvaluation
} from "../alert/index.js";
import {
  applyRestoreAuditMigration,
  BackupScheduler,
  createBackup,
  DEFAULT_BACKUP_CONFIG_PATH,
  loadBackupConfig,
  recordRestoreAudit,
  restoreBackup,
  runRestoreDrill
} from "../backup/index.js";
import {
  isConsolidationReportEnabled,
  isDeepRecallAvailable,
  isFactClaimsEnabled,
  type VegaConfig
} from "../config.js";
import { HOST_EVENT_ENVELOPE_V1 } from "../core/contracts/envelope.js";
import { INTENT_REQUEST_SCHEMA } from "../core/contracts/intent.js";
import { USAGE_ACK_SCHEMA } from "../core/contracts/usage-ack.js";
import { ArchiveService } from "../core/archive-service.js";
import { ConsolidationApprovalService } from "../core/consolidation-approval.js";
import { ConsolidationDashboardService } from "../core/consolidation-dashboard.js";
import { registerDefaultConsolidationDetectors } from "../core/consolidation-defaults.js";
import { ConsolidationReportEngine } from "../core/consolidation-report-engine.js";
import { ConsolidationScheduler } from "../core/consolidation-scheduler.js";
import { buildSourceContext, inferIntegrationSurface } from "../core/device.js";
import { DiagnoseService } from "../core/diagnose.js";
import { FactClaimService } from "../core/fact-claim-service.js";
import { GraphReportService } from "../core/graph-report.js";
import { getHealthReport } from "../core/health.js";
import { createLogger } from "../core/logging/index.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { TopicService } from "../core/topic-service.js";
import { createCandidateRepository } from "../db/candidate-repository.js";
import { createShadowAwareRepository } from "../db/shadow-aware-repository.js";
import { Repository } from "../db/repository.js";
import { ContentDistiller } from "../ingestion/distiller.js";
import { ContentFetcher } from "../ingestion/fetcher.js";
import { createIngestEventMcpTool } from "../ingestion/ingest-event-handler.js";
import { memoryToEnvelope } from "../ingestion/memory-to-envelope.js";
import { applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { createShadowWriter } from "../ingestion/shadow-writer.js";
import { IngestionService } from "../ingestion/service.js";
import { publishWikiPages } from "../publishing/service.js";
import {
  CANDIDATE_CREATE_SCHEMA,
  CANDIDATE_EVALUATE_SCHEMA,
  CANDIDATE_DEMOTE_SCHEMA,
  CANDIDATE_LIST_SCHEMA,
  CANDIDATE_PROMOTE_SCHEMA,
  CANDIDATE_SWEEP_SCHEMA,
  createCandidateCreateMcpTool,
  createCandidateEvaluateMcpTool,
  createCandidateDemoteMcpTool,
  createCandidateListMcpTool,
  createCandidatePromoteMcpTool,
  createCandidateSweepMcpTool,
  createDefaultPromotionPolicy,
  createPromotionAuditStore,
  createPromotionEvaluator,
  createPromotionOrchestrator,
  resolveJudgmentRulesOverrideFromEnv
} from "../promotion/index.js";
import {
  CIRCUIT_BREAKER_RESET_INPUT_SCHEMA,
  CIRCUIT_BREAKER_STATUS_INPUT_SCHEMA,
  createCircuitBreakerResetMcpTool,
  createCircuitBreakerStatusMcpTool
} from "../retrieval/circuit-breaker-mcp-tools.js";
import { createCircuitBreaker } from "../retrieval/circuit-breaker.js";
import {
  DEFAULT_FEATURE_FLAG_REGISTRY_PATH,
  createEvaluateFlagMcpTool,
  createFlagHitMetricsCollector,
  createFlagMetricsMcpTool,
  createListFlagsMcpTool,
  evaluateFeatureFlag,
  loadFeatureFlagRegistry
} from "../feature-flags/index.js";
import { createContextResolveMcpTool } from "../retrieval/context-resolve-handler.js";
import { createDefaultRegistry } from "../retrieval/orchestrator-config.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import { createCandidateMemoryAdapter } from "../retrieval/sources/candidate-memory.js";
import { applyHostMemoryFileFtsMigration } from "../retrieval/sources/host-memory-file-fts.js";
import { HOST_MEMORY_FILE_ENTRIES_TABLE } from "../retrieval/sources/host-memory-file-fts.js";
import { HostMemoryFileAdapter } from "../retrieval/sources/host-memory-file.js";
import { SourceRegistry } from "../retrieval/sources/registry.js";
import {
  applyReconciliationFindingsMigration,
  createReconciliationRunMcpTool,
  ReconciliationOrchestrator
} from "../reconciliation/index.js";
import {
  createAckStore,
  createCheckpointFailureStore,
  createCheckpointStore
} from "../usage/index.js";
import { createUsageAckMcpTool } from "../usage/usage-ack-handler.js";
import { CrossReferenceService } from "../wiki/cross-reference.js";
import { PageManager } from "../wiki/page-manager.js";
import { reviewWikiPage, WIKI_REVIEW_ACTIONS } from "../wiki/review.js";
import { searchWikiPages } from "../wiki/search.js";
import { SynthesisEngine } from "../wiki/synthesis.js";
import {
  createChangelogNotifier,
  evaluateSunsetCandidates,
  inspectSunsetRegistry,
  SunsetScheduler,
  type SunsetEvaluationResult
} from "../sunset/index.js";
import {
  resolveTimeoutSweepConfig,
  sweepCheckpointTimeouts,
  TimeoutSweepScheduler
} from "../timeout/index.js";
import { SESSION_START_MODE_VALUES } from "../core/types.js";
import type {
  ApprovalItem,
  AuditContext,
  AsOfQueryOptions,
  CompactResult,
  ConsolidationReport,
  CrossProjectTopicMemory,
  DeepRecallRequest,
  DeepRecallResponse,
  FactClaim,
  FactClaimStatus,
  GraphNeighborsResult,
  GraphPathResult,
  GraphQueryResult,
  GraphStats,
  GraphSubgraphResult,
  HealthInfo,
  Memory,
  MemoryListFilters,
  MemorySource,
  MemoryType,
  MemoryUpdateParams,
  SearchOptions,
  SearchResult,
  SessionStartMode,
  SessionStartResult,
  StoreParams,
  StoreResult,
  Topic,
  TunnelView
} from "../core/types.js";
import { WIKI_PAGE_STATUSES, WIKI_PAGE_TYPES } from "../wiki/types.js";

const MEMORY_TYPES = [
  "task_state",
  "preference",
  "project_context",
  "decision",
  "pitfall",
  "insight"
] as const satisfies readonly MemoryType[];

const MEMORY_SOURCES = ["auto", "explicit"] as const satisfies readonly MemorySource[];

function createRetrievalRegistry(
  deps: Parameters<typeof createDefaultRegistry>[0] & {
    candidateRepository?: ReturnType<typeof createCandidateRepository>;
  }
): SourceRegistry {
  const baseRegistry = createDefaultRegistry(deps);

  if (deps.repository === undefined || deps.repository.db.isPostgres || deps.candidateRepository === undefined) {
    return baseRegistry;
  }

  const registry = new SourceRegistry();

  for (const adapter of baseRegistry.list()) {
    if (adapter.kind === "candidate") {
      continue;
    }

    registry.register(adapter);
  }

  registry.register(
    createCandidateMemoryAdapter({
      repository: deps.candidateRepository
    })
  );

  return registry;
}
const SESSION_START_MODES = SESSION_START_MODE_VALUES;
const FACT_CLAIM_STATUSES = [
  "active",
  "expired",
  "suspected_expired",
  "conflict"
] as const satisfies readonly FactClaimStatus[];
const MCP_AUDIT_CONTEXT: AuditContext = { actor: "mcp", ip: null };
const logger = createLogger({ name: "mcp-server" });
const USAGE_ACK_ECHO_SOURCE_KIND_FLAG_ID = "usage-ack-echo-source-kind";

function resolveFeatureFlagRegistryPath(): string {
  const override = process.env.VEGA_FEATURE_FLAG_REGISTRY_PATH?.trim();
  return override && override.length > 0 ? override : DEFAULT_FEATURE_FLAG_REGISTRY_PATH;
}

function resolveFlagVariant(
  flags: ReturnType<typeof loadFeatureFlagRegistry>,
  id: string,
  fallback: "on" | "off",
  context: {
    surface?: string;
    intent?: string;
    session_id?: string;
    project?: string;
  }
): "on" | "off" {
  const flag = flags.find((candidate) => candidate.id === id);
  return flag === undefined ? fallback : evaluateFeatureFlag(flag, context).variant;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const countMemories = (repository: Repository): number =>
  repository.listMemories({
    limit: 1_000_000
  }).length;

const countHostMemoryFileEntries = (repository: Repository): number => {
  if (repository.db.isPostgres) {
    return 0;
  }

  return (
    repository.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${HOST_MEMORY_FILE_ENTRIES_TABLE}`
    )?.count ?? 0
  );
};

interface HostMemoryFileRefreshResult {
  schema_version: "1.0";
  refreshed_at: string;
  indexed_paths: number;
  duration_ms: number;
  degraded?: "adapter_disabled" | "sqlite_only";
}

interface SunsetCheckResult {
  schema_version: "1.0";
  evaluated_at: string;
  candidates: SunsetEvaluationResult[];
  degraded?: "registry_missing" | "parse_error";
}

interface AlertCheckResult {
  schema_version: "1.0";
  evaluated_at: string;
  evaluations: AlertEvaluation[];
  degraded?: "rules_missing" | "channels_missing" | "parse_error";
}

interface AlertFireResult {
  schema_version: "1.0";
  fired_at: string;
  dispatch_status: Record<string, string>;
  degraded?: "rules_missing" | "channels_missing" | "parse_error" | "rule_not_found";
}

interface BackupCreateResult {
  schema_version: "1.0";
  backup_id: string;
  path: string;
  file_count: number;
  total_bytes: number;
  manifest_sha256: string;
  degraded?: "file_read_error";
}

interface BackupRestoreResult {
  schema_version: "1.0";
  restored_at: string;
  files_restored: number;
  verified: boolean;
  mismatches: string[];
  degraded?: "backup_missing" | "manifest_parse_error" | "file_read_error";
}

interface BackupRestoreDrillResult {
  schema_version: "1.0";
  verified: boolean;
  mismatches: string[];
  degraded?: "backup_missing" | "manifest_parse_error" | "file_read_error";
}

const toTextResult = (result: unknown, isError = false): CallToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(result, null, 2)
    }
  ],
  ...(isError ? { isError: true } : {})
});

const serializeMemory = (memory: Memory) => ({
  id: memory.id,
  type: memory.type,
  project: memory.project,
  tenant_id: memory.tenant_id ?? null,
  title: memory.title,
  content: memory.content,
  summary: memory.summary ?? null,
  importance: memory.importance,
  source: memory.source,
  tags: memory.tags,
  created_at: memory.created_at,
  updated_at: memory.updated_at,
  accessed_at: memory.accessed_at,
  access_count: memory.access_count,
  status: memory.status,
  verified: memory.verified,
  scope: memory.scope,
  accessed_projects: memory.accessed_projects,
  source_context: memory.source_context ?? null
});

const serializeSessionStartResult = (result: SessionStartResult) => ({
  project: result.project,
  active_tasks: result.active_tasks.map(serializeMemory),
  preferences: result.preferences.map(serializeMemory),
  context: result.context.map(serializeMemory),
  relevant: result.relevant.map(serializeMemory),
  relevant_wiki_pages: result.relevant_wiki_pages,
  wiki_drafts_pending: result.wiki_drafts_pending,
  recent_unverified: result.recent_unverified.map(serializeMemory),
  conflicts: result.conflicts.map(serializeMemory),
  proactive_warnings: result.proactive_warnings,
  token_estimate: result.token_estimate,
  ...(result.graph_report !== undefined ? { graph_report: result.graph_report } : {}),
  ...(result.deep_recall !== undefined ? { deep_recall: result.deep_recall } : {})
});

const serializeFactClaim = (claim: FactClaim) => ({
  id: claim.id,
  tenant_id: claim.tenant_id ?? null,
  project: claim.project,
  source_memory_id: claim.source_memory_id,
  evidence_archive_id: claim.evidence_archive_id,
  canonical_key: claim.canonical_key,
  subject: claim.subject,
  predicate: claim.predicate,
  claim_value: claim.claim_value,
  claim_text: claim.claim_text,
  source: claim.source,
  status: claim.status,
  confidence: claim.confidence,
  valid_from: claim.valid_from,
  valid_to: claim.valid_to,
  temporal_precision: claim.temporal_precision,
  invalidation_reason: claim.invalidation_reason,
  created_at: claim.created_at,
  updated_at: claim.updated_at
});

const serializeEntity = (entity: {
  id: string;
  name: string;
  type: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}) => ({
  id: entity.id,
  name: entity.name,
  type: entity.type,
  metadata: entity.metadata ?? {},
  created_at: entity.created_at
});

const serializeGraphQueryResult = (result: GraphQueryResult) => ({
  entity: result.entity,
  relations: result.relations,
  memories: result.memories.map(serializeMemory)
});

const serializeGraphNeighborsResult = (result: GraphNeighborsResult) => ({
  entity: result.entity ? serializeEntity(result.entity) : null,
  neighbors: result.neighbors.map(serializeEntity),
  relations: result.relations,
  memories: result.memories.map(serializeMemory)
});

const serializeGraphPathResult = (result: GraphPathResult) => ({
  from: result.from ? serializeEntity(result.from) : null,
  to: result.to ? serializeEntity(result.to) : null,
  entities: result.entities.map(serializeEntity),
  relations: result.relations,
  memories: result.memories.map(serializeMemory),
  found: result.found
});

const serializeGraphSubgraphResult = (result: GraphSubgraphResult) => ({
  seed_entities: result.seed_entities.map(serializeEntity),
  missing_entities: result.missing_entities,
  entities: result.entities.map(serializeEntity),
  relations: result.relations,
  memories: result.memories.map(serializeMemory)
});

const serializeGraphStats = (result: GraphStats) => ({
  ...(result.project ? { project: result.project } : {}),
  total_entities: result.total_entities,
  total_relations: result.total_relations,
  entity_types: result.entity_types,
  relation_types: result.relation_types,
  average_confidence: result.average_confidence,
  tracked_code_files: result.tracked_code_files,
  tracked_doc_files: result.tracked_doc_files
});

const serializeWikiPageListEntry = (page: {
  id: string;
  slug: string;
  title: string;
  page_type: string;
  status: string;
  updated_at: string;
}) => ({
  id: page.id,
  slug: page.slug,
  title: page.title,
  page_type: page.page_type,
  status: page.status,
  updated_at: page.updated_at
});

const serializeTopic = (topic: Topic) => ({
  id: topic.id,
  tenant_id: topic.tenant_id ?? null,
  project: topic.project,
  topic_key: topic.topic_key,
  version: topic.version,
  label: topic.label,
  kind: topic.kind,
  description: topic.description,
  source: topic.source,
  state: topic.state,
  supersedes_topic_id: topic.supersedes_topic_id,
  created_at: topic.created_at,
  updated_at: topic.updated_at
});

const serializeCrossProjectTopicMemory = (entry: CrossProjectTopicMemory) => ({
  topic: serializeTopic(entry.topic),
  memory: serializeMemory(entry.memory)
});

const serializeTunnelView = (result: TunnelView) => ({
  topic_key: result.topic_key,
  project_count: result.project_count,
  total_memory_count: result.total_memory_count,
  projects: result.projects.map((project) => ({
    project: project.project,
    topic: serializeTopic(project.topic),
    memory_count: project.memory_count,
    memories_by_type: Object.fromEntries(
      Object.entries(project.memories_by_type).map(([type, memories]) => [
        type,
        (memories ?? []).map(serializeMemory)
      ])
    )
  })),
  common_pitfalls: result.common_pitfalls,
  common_decisions: result.common_decisions
});

const serializeConsolidationReport = (report: ConsolidationReport) => report;

const serializeApprovalItem = (item: ApprovalItem) => ({
  id: item.id,
  run_id: item.run_id,
  project: item.project,
  tenant_id: item.tenant_id,
  candidate_kind: item.candidate_kind,
  candidate_action: item.candidate_action,
  candidate_risk: item.candidate_risk,
  memory_ids: item.memory_ids,
  fact_claim_ids: item.fact_claim_ids,
  description: item.description,
  evidence: item.evidence,
  score: item.score,
  status: item.status,
  reviewed_by: item.reviewed_by,
  reviewed_at: item.reviewed_at,
  review_comment: item.review_comment,
  created_at: item.created_at,
  updated_at: item.updated_at
});

const resultCountForSessionStart = (result: SessionStartResult): number =>
  result.active_tasks.length +
  result.preferences.length +
  result.context.length +
  result.relevant.length +
  result.relevant_wiki_pages.length +
  result.recent_unverified.length +
  result.conflicts.length +
  (result.graph_report === undefined ? 0 : 1) +
  (result.deep_recall?.results.length ?? 0);

const dbg = (msg: string) => {
  appendFileSync("/tmp/vega-mcp-debug.log", `${new Date().toISOString()} [server] ${msg}\n`);
};

const inferProjectFromInput = (input: unknown): string => {
  if (!isRecord(input)) {
    return "global";
  }

  if (typeof input.project === "string" && input.project.trim().length > 0) {
    return input.project.trim();
  }

  if (
    typeof input.working_directory === "string" &&
    input.working_directory.trim().length > 0
  ) {
    return basename(resolve(input.working_directory));
  }

  return "global";
};

const runTool = async <T>(
  repository: Repository,
  operation: string,
  input: unknown,
  observer: {
    enabled: boolean;
    service?: {
      shouldObserve(toolName: string): boolean;
      observeToolOutput(
        toolName: string,
        input: unknown,
        output: unknown,
        project: string
      ): Promise<string | null>;
    };
  },
  execute: () => Promise<{ result: T; resultCount: number }>
): Promise<CallToolResult> => {
  dbg(`runTool called: ${operation}`);
  const startedAt = Date.now();
  let resultCount = 0;

  try {
    const executed = await execute();
    resultCount = executed.resultCount;
    if (
      observer.enabled &&
      observer.service !== undefined &&
      observer.service.shouldObserve(operation)
    ) {
      await observer.service.observeToolOutput(
        operation,
        input,
        executed.result,
        inferProjectFromInput(input)
      );
    }
    dbg(`runTool ${operation} OK in ${Date.now() - startedAt}ms`);
    return toTextResult(executed.result);
  } catch (error) {
    if (
      observer.enabled &&
      observer.service !== undefined &&
      observer.service.shouldObserve(operation)
    ) {
      await observer.service.observeToolOutput(
        operation,
        input,
        error instanceof Error
          ? {
              error: error.message
            }
          : {
              error: String(error)
            },
        inferProjectFromInput(input)
      );
    }
    dbg(`runTool ${operation} ERROR: ${error}`);
    return toTextResult(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      true
    );
  } finally {
    repository.logPerformance({
      timestamp: new Date().toISOString(),
      operation,
      latency_ms: Date.now() - startedAt,
      memory_count: countMemories(repository),
      result_count: resultCount
    });
  }
};

export interface CreateMCPServerOptions {
  repository: Repository;
  graphService: {
    query(
      entityName: string,
      depth?: number,
      minConfidence?: number
    ): GraphQueryResult | Promise<GraphQueryResult>;
    getNeighbors(
      entityName: string,
      depth?: number,
      minConfidence?: number
    ): GraphNeighborsResult | Promise<GraphNeighborsResult>;
    shortestPath(
      fromEntity: string,
      toEntity: string,
      maxDepth?: number
    ): GraphPathResult | Promise<GraphPathResult>;
    graphStats(project?: string): GraphStats | Promise<GraphStats>;
    subgraph(entityNames: string[], depth?: number): GraphSubgraphResult | Promise<GraphSubgraphResult>;
  };
  memoryService: {
    store(params: StoreParams): Promise<StoreResult>;
    update(id: string, updates: MemoryUpdateParams, auditContext?: AuditContext): Promise<void>;
    delete(id: string, auditContext?: AuditContext): Promise<void>;
  };
  recallService: {
    recall(query: string, options: SearchOptions): Promise<SearchResult[]>;
    listMemories(filters: MemoryListFilters): Memory[] | Promise<Memory[]>;
  };
  sessionService: {
    sessionStart(
      workingDirectory: string,
      taskHint?: string,
      tenantId?: string | null,
      mode?: SessionStartMode,
      activityContext?: {
        surface?: string;
        integration?: string;
      }
    ): Promise<SessionStartResult>;
    sessionEnd(
      project: string,
      summary: string,
      completedTasks?: string[],
      auditContext?: AuditContext
    ): Promise<void>;
  };
  compactService: {
    compact(project?: string, auditContext?: AuditContext): CompactResult | Promise<CompactResult>;
  };
  archiveService?: {
    deepRecall(
      request: DeepRecallRequest,
      tenantId?: string | null
    ): DeepRecallResponse | Promise<DeepRecallResponse>;
  };
  factClaimService?: {
    listClaims(
      project: string,
      status?: FactClaimStatus | FactClaimStatus[],
      asOf?: string | AsOfQueryOptions,
      tenantId?: string | null
    ): FactClaim[] | Promise<FactClaim[]>;
    resolveClaim(
      id: string,
      newStatus: FactClaimStatus,
      reason?: string
    ): FactClaim | Promise<FactClaim>;
    asOfQuery(
      project: string,
      timestamp: string,
      subject?: string,
      predicate?: string,
      options?: Pick<AsOfQueryOptions, "include_suspected_expired" | "include_conflicts">,
      tenantId?: string | null
    ): FactClaim[] | Promise<FactClaim[]>;
  };
  compressionService?: {
    compressMemory(memoryId: string): Promise<{
      original_length: number;
      compressed_length: number;
      applied: boolean;
    }>;
    compressBatch(
      project?: string,
      minLength?: number
    ): Promise<{ processed: number; compressed: number; saved_chars: number }>;
  };
  observerService?: {
    shouldObserve(toolName: string): boolean;
    observeToolOutput(
      toolName: string,
      input: unknown,
      output: unknown,
      project: string
    ): Promise<string | null>;
  };
  config: VegaConfig;
  healthProvider?: () => Promise<HealthInfo>;
  homeDir?: string;
}

export function createMCPServer({
  repository,
  graphService,
  memoryService,
  recallService,
  sessionService,
  compactService,
  archiveService,
  factClaimService,
  compressionService,
  observerService,
  config,
  healthProvider,
  homeDir
}: CreateMCPServerOptions): McpServer {
  const server = new McpServer({
    name: "vega-memory",
    version: "0.1.0"
  });
  let activeRepository = repository;
  let activeMemoryService = memoryService;
  let activeSessionService = sessionService;

  if (!repository.db.isPostgres) {
    applyRawInboxMigration(repository.db);
    applyHostMemoryFileFtsMigration(repository.db);
    applyReconciliationFindingsMigration(repository.db);
    const shadowWrite = createShadowWriter({ db: repository.db });
    const shadowWriteForMemoryService = (memory: Memory): void => {
      try {
        const outcome = shadowWrite(
          memoryToEnvelope(memory, {
            default_surface: "api"
          })
        );

        if (outcome.executed && outcome.reason === "error") {
          logger.warn("MemoryService shadow write failed", {
            memory_id: memory.id,
            error: outcome.error ?? "unknown error"
          });
        }
      } catch (error) {
        logger.warn("MemoryService shadow write throw caught", {
          memory_id: memory.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };
    activeRepository = createShadowAwareRepository(repository, shadowWrite);

    if (memoryService instanceof MemoryService) {
      activeMemoryService = new MemoryService(
        activeRepository,
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        shadowWriteForMemoryService
      );
    }

    if (sessionService instanceof SessionService) {
      const sessionMemoryService =
        activeMemoryService instanceof MemoryService
          ? activeMemoryService
          : new MemoryService(
              activeRepository,
              config,
              undefined,
              undefined,
              undefined,
              undefined,
              shadowWriteForMemoryService
            );
      activeSessionService = new SessionService(
        activeRepository,
        sessionMemoryService,
        recallService as RecallService,
        config
      );
    }
  }

  const diagnoseService = new DiagnoseService(activeRepository, config);
  const graphReportService = new GraphReportService(activeRepository);
  const topicService = new TopicService(activeRepository, config);
  const approvalService = new ConsolidationApprovalService(activeRepository);
  const rawArchiveService = archiveService ?? new ArchiveService(activeRepository, config);
  const claimsService = factClaimService ?? new FactClaimService(activeRepository, config);
  const retrievalArchiveService = new ArchiveService(activeRepository, config);
  const retrievalFactClaimService = new FactClaimService(activeRepository, config);
  const checkpointStore = !activeRepository.db.isPostgres
    ? createCheckpointStore(activeRepository.db)
    : undefined;
  const ackStore = !activeRepository.db.isPostgres
    ? createAckStore(activeRepository.db)
    : undefined;
  const checkpointFailureStore = !activeRepository.db.isPostgres
    ? createCheckpointFailureStore(activeRepository.db)
    : undefined;
  const circuitBreaker =
    !activeRepository.db.isPostgres && checkpointStore && ackStore
      ? createCircuitBreaker()
      : undefined;
  const candidateRepository = !activeRepository.db.isPostgres
    ? createCandidateRepository(activeRepository.db)
    : undefined;
  const promotionAuditStore = !activeRepository.db.isPostgres
    ? createPromotionAuditStore(activeRepository.db)
    : undefined;
  const promotionPolicy = createDefaultPromotionPolicy(
    resolveJudgmentRulesOverrideFromEnv(process.env)
  );
  const promotionEvaluator =
    candidateRepository !== undefined
      ? createPromotionEvaluator({
          policy: promotionPolicy,
          ackStore
        })
      : undefined;
  const promotionOrchestrator =
    candidateRepository !== undefined &&
    promotionAuditStore !== undefined &&
    promotionEvaluator !== undefined
      ? createPromotionOrchestrator({
          evaluator: promotionEvaluator,
          candidateRepository,
          repository: activeRepository,
          auditStore: promotionAuditStore
        })
      : undefined;

  if (activeRepository.db.isPostgres) {
    logger.warn(
      "Phase 8 persistence disabled: CheckpointStore, AckStore, CheckpointFailureStore require SQLite backend. context.resolve/usage.ack still accept traffic but responses carry degraded flags."
    );
  } else {
    applyRestoreAuditMigration(activeRepository.db);
  }
  const observer = {
    enabled: config.observerEnabled,
    service: observerService
  };
  const pageManager = new PageManager(activeRepository);
  const synthesisEngine = new SynthesisEngine(activeRepository, pageManager, config);
  const crossReferenceService = new CrossReferenceService(pageManager);
  const contentFetcher = new ContentFetcher();
  const contentDistiller = new ContentDistiller(config);
  const ingestionService = new IngestionService(
    contentFetcher,
    contentDistiller,
    pageManager,
    activeMemoryService,
    synthesisEngine,
    config
  );
  const retrievalRegistry = createRetrievalRegistry({
    repository: activeRepository,
    candidateRepository,
    wikiSearch: searchWikiPages,
    factClaimService: retrievalFactClaimService,
    graphReportService,
    archiveService: retrievalArchiveService,
    homeDir
  });
  const hostMemoryFileAdapter = retrievalRegistry.get("host_memory_file");
  const refreshableHostMemoryFileAdapter =
    hostMemoryFileAdapter instanceof HostMemoryFileAdapter ? hostMemoryFileAdapter : undefined;
  const sunsetScheduler = new SunsetScheduler({
    registry: async () => inspectSunsetRegistry().candidates,
    evaluator: async (candidates) =>
      evaluateSunsetCandidates(candidates, {
        db: activeRepository.db,
        now: new Date(),
        metricsQuery: async () => null
      }),
    notifier: createChangelogNotifier(resolve(process.cwd(), "CHANGELOG.md"))
  });
  const alertRules = loadAlertRules(DEFAULT_ALERT_RULES_PATH, process.env);
  const alertChannels = loadAlertChannels(DEFAULT_ALERT_CHANNELS_PATH, process.env);
  const alertScheduler = new AlertScheduler({
    db: activeRepository.db,
    rules: alertRules,
    channels: alertChannels,
    evaluator: () =>
      evaluateAlertRules(alertRules, {
        metricsQuery: async () => null,
        now: () => new Date()
      })
  });
  const backupHomeDir = homeDir ?? process.env.HOME ?? process.cwd();
  const backupConfig = loadBackupConfig(DEFAULT_BACKUP_CONFIG_PATH, {
    env: {
      ...process.env,
      HOME: backupHomeDir
    }
  });
  const backupScheduler = new BackupScheduler({
    config: backupConfig,
    homeDir: backupHomeDir,
    db: activeRepository.db
  });
  const timeoutSweepConfig = resolveTimeoutSweepConfig(process.env);
  const featureFlags = loadFeatureFlagRegistry(resolveFeatureFlagRegistryPath());
  const timeoutSweepScheduler = new TimeoutSweepScheduler({
    db: activeRepository.db,
    config: timeoutSweepConfig
  });

  if (process.env.VEGA_SUNSET_SCHEDULER_ENABLED !== "false") {
    sunsetScheduler.start();
  }
  if (process.env.VEGA_ALERT_SCHEDULER_ENABLED !== "false") {
    alertScheduler.start();
  }
  if (process.env.VEGA_BACKUP_SCHEDULER_ENABLED !== "false") {
    backupScheduler.start();
  }
  if (timeoutSweepConfig.enabled) {
    timeoutSweepScheduler.start();
  }
  const retrievalOrchestrator = new RetrievalOrchestrator({
    registry: retrievalRegistry,
    checkpoint_store: checkpointStore,
    checkpoint_failure_store: checkpointFailureStore,
    circuit_breaker: circuitBreaker
  });
  const ingestEventTool = createIngestEventMcpTool(activeRepository.db, {
    candidateRepository,
    promotionOrchestrator
  });
  const contextResolveTool = createContextResolveMcpTool(retrievalOrchestrator);
  const usageAckTool = createUsageAckMcpTool(
    ackStore,
    checkpointStore,
    undefined,
    circuitBreaker
  );
  const circuitBreakerStatusTool = createCircuitBreakerStatusMcpTool(circuitBreaker);
  const circuitBreakerResetTool = createCircuitBreakerResetMcpTool(circuitBreaker);
  const flagHitMetrics = createFlagHitMetricsCollector();
  const evaluateFlagTool = createEvaluateFlagMcpTool(
    activeRepository.db,
    DEFAULT_FEATURE_FLAG_REGISTRY_PATH,
    flagHitMetrics
  );
  const listFlagsTool = createListFlagsMcpTool(activeRepository.db, DEFAULT_FEATURE_FLAG_REGISTRY_PATH);
  const flagMetricsTool = createFlagMetricsMcpTool(flagHitMetrics);
  const candidateCreateTool = createCandidateCreateMcpTool(candidateRepository);
  const candidateListTool = createCandidateListMcpTool(candidateRepository);
  const candidatePromoteTool = createCandidatePromoteMcpTool(promotionOrchestrator);
  const candidateDemoteTool = createCandidateDemoteMcpTool(promotionOrchestrator);
  const candidateEvaluateTool = createCandidateEvaluateMcpTool(promotionOrchestrator);
  const candidateSweepTool = createCandidateSweepMcpTool(promotionOrchestrator);
  const reconciliationRunTool = createReconciliationRunMcpTool(
    !activeRepository.db.isPostgres
      ? new ReconciliationOrchestrator({
          db: activeRepository.db
        })
      : undefined
  );

  server.tool(
    "memory_graph",
    "Query entity relations and connected memories from Vega Memory.",
    {
      entity: z.string().trim().min(1),
      depth: z.number().int().min(0).default(1),
      min_confidence: z.number().min(0).max(1).default(0)
    },
    async (args) =>
      runTool(repository, "memory_graph", args, observer, async () => {
        const result = await Promise.resolve(
          graphService.query(args.entity, args.depth, args.min_confidence)
        );

        return {
          result: serializeGraphQueryResult(result),
          resultCount: result.relations.length + result.memories.length
        };
      })
  );

  server.tool(
    "graph_neighbors",
    "Fetch neighboring graph nodes, relations, and memories for one entity.",
    {
      entity: z.string().trim().min(1),
      depth: z.number().int().min(0).default(1),
      min_confidence: z.number().min(0).max(1).default(0)
    },
    async (args) =>
      runTool(repository, "graph_neighbors", args, observer, async () => {
        const result = await Promise.resolve(
          graphService.getNeighbors(args.entity, args.depth, args.min_confidence)
        );

        return {
          result: serializeGraphNeighborsResult(result),
          resultCount: result.neighbors.length + result.relations.length + result.memories.length
        };
      })
  );

  server.tool(
    "graph_path",
    "Find the shortest path between two graph entities.",
    {
      from_entity: z.string().trim().min(1),
      to_entity: z.string().trim().min(1),
      max_depth: z.number().int().min(0).default(6)
    },
    async (args) =>
      runTool(repository, "graph_path", args, observer, async () => {
        const result = await Promise.resolve(
          graphService.shortestPath(args.from_entity, args.to_entity, args.max_depth)
        );

        return {
          result: serializeGraphPathResult(result),
          resultCount: result.entities.length + result.relations.length + result.memories.length
        };
      })
  );

  server.tool(
    "graph_stats",
    "Return aggregated statistics for the graph, optionally scoped to one project.",
    {
      project: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "graph_stats", args, observer, async () => {
        const result = await Promise.resolve(graphService.graphStats(args.project));

        return {
          result: serializeGraphStats(result),
          resultCount: Math.max(result.total_entities, result.total_relations, 1)
        };
      })
  );

  server.tool(
    "graph_subgraph",
    "Fetch the merged subgraph around one or more seed entities.",
    {
      entities: z.array(z.string().trim().min(1)).min(1),
      depth: z.number().int().min(0).default(1)
    },
    async (args) =>
      runTool(repository, "graph_subgraph", args, observer, async () => {
        const result = await Promise.resolve(graphService.subgraph(args.entities, args.depth));

        return {
          result: serializeGraphSubgraphResult(result),
          resultCount: result.entities.length + result.relations.length + result.memories.length
        };
      })
  );

  server.tool(
    "graph_report",
    "Generate a markdown project structure report from the graph sidecar.",
    {
      project: z.string().trim().min(1),
      save: z.boolean().default(false)
    },
    async (args) =>
      runTool(repository, "graph_report", args, observer, async () => {
        const result: { project: string; report: string; saved_path: string | null } = args.save
          ? (() => {
              const saved = graphReportService.saveGraphReport(args.project);

              return {
                project: saved.project,
                report: saved.report,
                saved_path: saved.path
              };
            })()
          : {
              project: args.project,
              report: graphReportService.generateGraphReport(args.project),
              saved_path: null
            };

        return {
          result,
          resultCount: 1
        };
      })
  );

  server.tool(
    "consolidation_report",
    "Generate a dry-run consolidation report analyzing memory quality and recommending cleanup actions.",
    {
      project: z.string().trim().min(1),
      tenant_id: z.string().trim().min(1).optional()
    },
    async (args) => {
      if (!isConsolidationReportEnabled(config)) {
        return toTextResult(
          {
            error: "consolidation_report feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "consolidation_report", args, observer, async () => {
        const engine = new ConsolidationReportEngine(activeRepository, config);
        registerDefaultConsolidationDetectors(engine);
        const result = engine.generateReport(args.project, args.tenant_id ?? undefined);

        return {
          result: serializeConsolidationReport(result),
          resultCount: result.summary.total_candidates
        };
      });
    }
  );

  server.tool(
    "consolidation_dashboard",
    "Get memory health metrics and consolidation effectiveness indicators.",
    {
      project: z.string().trim().min(1),
      tenant_id: z.string().trim().min(1).optional()
    },
    async (args) => {
      if (!isConsolidationReportEnabled(config)) {
        return toTextResult(
          {
            error: "consolidation_report feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "consolidation_dashboard", args, observer, async () => {
        const dashboard = new ConsolidationDashboardService(activeRepository, config);
        const result = dashboard.generateDashboard(args.project, args.tenant_id ?? undefined);

        return {
          result,
          resultCount: 1
        };
      });
    }
  );

  server.tool(
    "consolidation_run",
    "Execute a consolidation run with the specified policy.",
    {
      project: z.string().trim().min(1),
      tenant_id: z.string().trim().min(1).optional(),
      mode: z.enum(["dry_run", "auto_low_risk"]).default("dry_run"),
      trigger: z
        .enum(["manual", "nightly", "after_writes", "after_session_end"])
        .default("manual")
    },
    async (args) => {
      if (!isConsolidationReportEnabled(config)) {
        return toTextResult(
          {
            error: "consolidation_report feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "consolidation_run", args, observer, async () => {
        const scheduler = new ConsolidationScheduler(activeRepository, config);
        const result = scheduler.run(args.project, args.tenant_id ?? undefined, {
          mode: args.mode,
          trigger: args.trigger
        });

        return {
          result,
          resultCount: result.total_candidates
        };
      });
    }
  );

  server.tool(
    "consolidation_approvals_list",
    "List consolidation approval items, pending by default.",
    {
      project: z.string().trim().min(1),
      tenant_id: z.string().trim().min(1).optional(),
      status: z
        .enum([
          "pending",
          "approved",
          "approved_pending_execution",
          "execution_failed",
          "rejected",
          "expired"
        ])
        .default("pending"),
      limit: z.number().int().positive().max(1000).default(100)
    },
    async (args) => {
      if (!isConsolidationReportEnabled(config)) {
        return toTextResult(
          {
            error: "consolidation_report feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "consolidation_approvals_list", args, observer, async () => {
        const result = approvalService
          .listAll(args.project, args.status, args.tenant_id ?? undefined, args.limit)
          .map(serializeApprovalItem);

        return {
          result,
          resultCount: result.length
        };
      });
    }
  );

  server.tool(
    "consolidation_approval_review",
    "Approve or reject one consolidation approval item.",
    {
      item_id: z.string().trim().min(1),
      status: z.enum(["approved", "rejected"]),
      reviewed_by: z.string().trim().min(1),
      comment: z.string().trim().min(1).optional(),
      auto_execute: z.boolean().optional()
    },
    async (args) => {
      if (!isConsolidationReportEnabled(config)) {
        return toTextResult(
          {
            error: "consolidation_report feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "consolidation_approval_review", args, observer, async () => {
        const result = approvalService.review(
          {
            item_id: args.item_id,
            status: args.status,
            reviewed_by: args.reviewed_by,
            ...(args.comment ? { comment: args.comment } : {})
          },
          args.auto_execute ?? false
        );

        return {
          result: serializeApprovalItem(result),
          resultCount: 1
        };
      });
    }
  );

  server.tool(
    "consolidation_approval_retry",
    "Retry execution of a failed approval item.",
    {
      item_id: z.string().trim().min(1),
      retried_by: z.string().trim().min(1)
    },
    async (args) => {
      if (!isConsolidationReportEnabled(config)) {
        return toTextResult(
          {
            error: "consolidation_report feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "consolidation_approval_retry", args, observer, async () => {
        const result = approvalService.retry(args.item_id, args.retried_by);

        return {
          result: serializeApprovalItem(result),
          resultCount: 1
        };
      });
    }
  );

  server.tool(
    "consolidation_approval_execute",
    "Execute an already-approved consolidation item.",
    {
      item_id: z.string().trim().min(1),
      executed_by: z.string().trim().min(1)
    },
    async (args) => {
      if (!isConsolidationReportEnabled(config)) {
        return toTextResult(
          {
            error: "consolidation_report feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "consolidation_approval_execute", args, observer, async () => {
        const result = approvalService.execute(args.item_id, args.executed_by);

        return {
          result: serializeApprovalItem(result),
          resultCount: 1
        };
      });
    }
  );

  server.tool(
    "consolidation_approvals_pending_count",
    "Return the number of pending consolidation approval items for a project.",
    {
      project: z.string().trim().min(1),
      tenant_id: z.string().trim().min(1).optional()
    },
    async (args) => {
      if (!isConsolidationReportEnabled(config)) {
        return toTextResult(
          {
            error: "consolidation_report feature is disabled"
          },
          true
        );
      }

      return runTool(
        repository,
        "consolidation_approvals_pending_count",
        args,
        observer,
        async () => {
          const pending = approvalService.getPendingCount(args.project, args.tenant_id ?? undefined);

          return {
            result: {
              project: args.project,
              tenant_id: args.tenant_id ?? null,
              pending
            },
            resultCount: 1
          };
        }
      );
    }
  );

  server.tool(
    "memory_store",
    "Store a memory entry in Vega Memory.",
    {
      content: z.string().trim().min(1),
      type: z.enum(MEMORY_TYPES),
      project: z.string().trim().min(1).optional(),
      title: z.string().trim().min(1).optional(),
      tags: z.array(z.string().trim().min(1)).optional(),
      importance: z.number().min(0).max(1).optional(),
      source: z.enum(MEMORY_SOURCES).default("auto"),
      preserve_raw: z.boolean().optional(),
      source_actor: z.string().trim().min(1).optional(),
      source_client: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "memory_store", args, observer, async () => {
        const { source_actor, source_client, ...storeArgs } = args;
        const result = await activeMemoryService.store({
          ...storeArgs,
          project: args.project ?? "global",
          auditContext: MCP_AUDIT_CONTEXT,
          sourceContext: buildSourceContext(source_actor ?? "unknown", "mcp", {
            client_info: source_client,
            surface:
              inferIntegrationSurface(source_actor) ??
              inferIntegrationSurface(source_client),
            integration: "mcp"
          })
        });
        const memory = activeRepository.getMemory(result.id);

        return {
          result: {
            ...result,
            memory: memory === null ? null : serializeMemory(memory)
          },
          resultCount: 1
        };
      })
  );

  server.tool(
    "memory_recall",
    "Recall relevant memories from Vega Memory.",
    {
      query: z.string().trim().min(1),
      project: z.string().trim().min(1).optional(),
      type: z.enum(MEMORY_TYPES).optional(),
      limit: z.number().int().positive().default(5),
      min_similarity: z.number().min(0).max(1).default(0.3),
      source_surface: z.enum(["cursor", "codex", "claude", "api", "cli"]).optional(),
      source_integration: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "memory_recall", args, observer, async () => {
        const result = await recallService.recall(args.query, {
          project: args.project,
          type: args.type,
          source_surface: args.source_surface,
          source_integration: args.source_integration ?? "mcp",
          limit: args.limit,
          minSimilarity: args.min_similarity
        });

        return {
          result: result.map((entry) => ({
            id: entry.memory.id,
            type: entry.memory.type,
            project: entry.memory.project,
            tenant_id: entry.memory.tenant_id ?? null,
            title: entry.memory.title,
            content: entry.memory.content,
            summary: entry.memory.summary ?? null,
            importance: entry.memory.importance,
            source: entry.memory.source,
            tags: entry.memory.tags,
            created_at: entry.memory.created_at,
            updated_at: entry.memory.updated_at,
            accessed_at: entry.memory.accessed_at,
            access_count: entry.memory.access_count,
            status: entry.memory.status,
            verified: entry.memory.verified,
            scope: entry.memory.scope,
            accessed_projects: entry.memory.accessed_projects,
            source_context: entry.memory.source_context ?? null,
            similarity: entry.similarity,
            finalScore: entry.finalScore
          })),
          resultCount: result.length
        };
      })
  );

  server.tool(
    "deep_recall",
    "Retrieve cold evidence and archived original text from Vega Memory's raw archive tier.",
    {
      query: z.string().trim().min(1),
      project: z.string().trim().min(1).optional(),
      tenant_id: z.string().trim().min(1).optional(),
      limit: z.number().int().positive().default(5),
      evidence_limit: z.number().int().positive().optional(),
      include_content: z.boolean().default(true),
      include_metadata: z.boolean().default(false),
      inject_into_session: z.boolean().default(false)
    },
    async (args) => {
      if (!isDeepRecallAvailable(config)) {
        return toTextResult(
          {
            error: "deep_recall feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "deep_recall", args, observer, async () => {
        const result = await Promise.resolve(
          rawArchiveService.deepRecall(args, args.tenant_id ?? undefined)
        );

        return {
          result,
          resultCount: result.results.length
        };
      });
    }
  );

  server.tool(
    "fact_claim_list",
    "List fact claims, optionally filtered by status or as_of timestamp.",
    {
      project: z.string().trim().min(1),
      tenant_id: z.string().trim().min(1).optional(),
      status: z.enum(FACT_CLAIM_STATUSES).optional(),
      as_of: z.string().trim().min(1).optional(),
      include_suspected_expired: z.boolean().default(false),
      include_conflicts: z.boolean().default(false)
    },
    async (args) => {
      if (!isFactClaimsEnabled(config)) {
        return toTextResult(
          {
            error: "fact_claims feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "fact_claim_list", args, observer, async () => {
        const result = await Promise.resolve(
          claimsService.listClaims(
            args.project,
            args.status,
            args.as_of
              ? {
                  as_of: args.as_of,
                  include_suspected_expired: args.include_suspected_expired,
                  include_conflicts: args.include_conflicts
                }
              : undefined,
            args.tenant_id ?? undefined
          )
        );

        return {
          result: result.map(serializeFactClaim),
          resultCount: result.length
        };
      });
    }
  );

  server.tool(
    "fact_claim_update",
    "Update a fact claim status through the user-facing VM2 state machine.",
    {
      id: z.string().trim().min(1),
      status: z.enum(FACT_CLAIM_STATUSES),
      reason: z.string().trim().min(1).optional()
    },
    async (args) => {
      if (!isFactClaimsEnabled(config)) {
        return toTextResult(
          {
            error: "fact_claims feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "fact_claim_update", args, observer, async () => {
        const result = await Promise.resolve(
          claimsService.resolveClaim(args.id, args.status, args.reason)
        );

        return {
          result: serializeFactClaim(result),
          resultCount: 1
        };
      });
    }
  );

  server.tool(
    "fact_claim_query",
    "Run an as_of query against temporal fact claims.",
    {
      project: z.string().trim().min(1),
      as_of: z.string().trim().min(1),
      tenant_id: z.string().trim().min(1).optional(),
      subject: z.string().trim().min(1).optional(),
      predicate: z.string().trim().min(1).optional(),
      include_suspected_expired: z.boolean().default(false),
      include_conflicts: z.boolean().default(false)
    },
    async (args) => {
      if (!isFactClaimsEnabled(config)) {
        return toTextResult(
          {
            error: "fact_claims feature is disabled"
          },
          true
        );
      }

      return runTool(repository, "fact_claim_query", args, observer, async () => {
        const result = await Promise.resolve(
          claimsService.asOfQuery(
            args.project,
            args.as_of,
            args.subject,
            args.predicate,
            {
              include_suspected_expired: args.include_suspected_expired,
              include_conflicts: args.include_conflicts
            },
            args.tenant_id ?? undefined
          )
        );

        return {
          result: result.map(serializeFactClaim),
          resultCount: result.length
        };
      });
    }
  );

  server.tool(
    "memory_list",
    "List memories from Vega Memory.",
    {
      project: z.string().trim().min(1).optional(),
      type: z.enum(MEMORY_TYPES).optional(),
      limit: z.number().int().positive().default(20),
      sort: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "memory_list", args, observer, async () => {
        const result = await Promise.resolve(recallService.listMemories({
          project: args.project,
          type: args.type,
          limit: args.limit,
          sort: args.sort
        }));

        return {
          result: result.map(serializeMemory),
          resultCount: result.length
        };
      })
  );

  server.tool(
    "memory_update",
    "Update an existing memory entry.",
    {
      id: z.string().trim().min(1),
      title: z.string().trim().min(1).optional(),
      content: z.string().trim().min(1).optional(),
      importance: z.number().min(0).max(1).optional(),
      tags: z.array(z.string().trim().min(1)).optional()
    },
    async (args) =>
      runTool(repository, "memory_update", args, observer, async () => {
        await activeMemoryService.update(
          args.id,
          {
            title: args.title,
            content: args.content,
            importance: args.importance,
            tags: args.tags
          },
          MCP_AUDIT_CONTEXT
        );

        return {
          result: {
            id: args.id,
            action: "updated"
          },
          resultCount: 1
        };
      })
  );

  server.tool(
    "memory_delete",
    "Delete a memory entry.",
    {
      id: z.string().trim().min(1)
    },
    async (args) =>
      runTool(repository, "memory_delete", args, observer, async () => {
        await activeMemoryService.delete(args.id, MCP_AUDIT_CONTEXT);

        return {
          result: {
            id: args.id,
            action: "deleted"
          },
          resultCount: 1
        };
      })
  );

  server.tool(
    "topic_override",
    "Create a new explicit topic version and supersede the current head.",
    {
      project: z.string().trim().min(1),
      topic_key: z.string().trim().min(1),
      label: z.string().trim().min(1),
      description: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "topic_override", args, observer, async () => {
        const result = await topicService.overrideTopic(
          args.project,
          args.topic_key,
          args.label,
          args.description,
          MCP_AUDIT_CONTEXT
        );

        return {
          result: {
            ...result,
            topic: serializeTopic(result.topic)
          },
          resultCount: Math.max(result.reassigned_memory_count, 1)
        };
      })
  );

  server.tool(
    "topic_revert",
    "Create a new active topic head from a historical version.",
    {
      project: z.string().trim().min(1),
      topic_key: z.string().trim().min(1),
      target_version: z.number().int().positive()
    },
    async (args) =>
      runTool(repository, "topic_revert", args, observer, async () => {
        const result = await topicService.revertTopic(
          args.project,
          args.topic_key,
          args.target_version,
          MCP_AUDIT_CONTEXT
        );

        return {
          result: {
            ...result,
            topic: serializeTopic(result.topic)
          },
          resultCount: Math.max(result.reassigned_memory_count, 1)
        };
      })
  );

  server.tool(
    "topic_history",
    "List all stored versions for a topic key.",
    {
      project: z.string().trim().min(1),
      topic_key: z.string().trim().min(1)
    },
    async (args) =>
      runTool(repository, "topic_history", args, observer, async () => {
        const result = topicService.listTopicVersions(args.project, args.topic_key);

        return {
          result: result.map(serializeTopic),
          resultCount: result.length
        };
      })
  );

  server.tool(
    "topic_reassign",
    "Reclassify one memory from one topic key to another.",
    {
      memory_id: z.string().trim().min(1),
      from_topic_key: z.string().trim().min(1),
      to_topic_key: z.string().trim().min(1)
    },
    async (args) =>
      runTool(repository, "topic_reassign", args, observer, async () => {
        const result = await topicService.reassignMemoryTopic(
          args.memory_id,
          args.from_topic_key,
          args.to_topic_key,
          MCP_AUDIT_CONTEXT
        );

        return {
          result,
          resultCount: 1
        };
      })
  );

  server.tool(
    "topic_tunnel",
    "Return the cross-project tunnel view for a topic key.",
    {
      topic_key: z.string().trim().min(1),
      tenant_id: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "topic_tunnel", args, observer, async () => {
        const result = topicService.getTunnelView(args.topic_key, args.tenant_id ?? undefined);

        return {
          result: serializeTunnelView(result),
          resultCount: Math.max(result.total_memory_count, result.project_count)
        };
      })
  );

  server.tool(
    "topic_cross_project",
    "List cross-project memories attached to the same topic key.",
    {
      topic_key: z.string().trim().min(1),
      tenant_id: z.string().trim().min(1).optional(),
      type: z.enum(MEMORY_TYPES).optional()
    },
    async (args) =>
      runTool(repository, "topic_cross_project", args, observer, async () => {
        const result = topicService.getCrossProjectMemories(
          args.topic_key,
          args.type,
          args.tenant_id ?? undefined
        );

        return {
          result: result.map(serializeCrossProjectTopicMemory),
          resultCount: result.length
        };
      })
  );

  server.tool(
    "session_start",
    "Start a Vega Memory session for a working directory.",
    {
      working_directory: z.string().trim().min(1),
      task_hint: z.string().trim().min(1).optional(),
      mode: z.enum(SESSION_START_MODES).default("standard"),
      source_surface: z.enum(["cursor", "codex", "claude", "api", "cli"]).optional(),
      source_integration: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "session_start", args, observer, async () => {
        const result = await activeSessionService.sessionStart(
          args.working_directory,
          args.task_hint,
          undefined,
          args.mode,
          {
            surface: args.source_surface,
            integration: args.source_integration ?? "mcp"
          }
        );

        return {
          result: serializeSessionStartResult(result),
          resultCount: resultCountForSessionStart(result)
        };
      })
  );

  server.tool(
    "session_end",
    "Finish a Vega Memory session and persist extracted memories.",
    {
      project: z.string().trim().min(1),
      summary: z.string().trim().min(1),
      completed_tasks: z.array(z.string().trim().min(1)).optional()
    },
    async (args) =>
      runTool(repository, "session_end", args, observer, async () => {
        await activeSessionService.sessionEnd(
          args.project,
          args.summary,
          args.completed_tasks,
          MCP_AUDIT_CONTEXT
        );

        return {
          result: {
            project: args.project,
            action: "ended"
          },
          resultCount: 1
        };
      })
  );

  server.tool(
    "memory_health",
    "Return Vega Memory health information, including regression guard status.",
    {},
    async () =>
      runTool(repository, "memory_health", {}, observer, async () => {
        const result =
          healthProvider === undefined
            ? await getHealthReport(activeRepository, config)
            : await healthProvider();

        return {
          result,
          resultCount: 1
        };
      })
  );

  server.tool(
    "memory_diagnose",
    "Run a diagnostic report for Vega Memory.",
    {
      issue: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "memory_diagnose", args, observer, async () => {
        const result = await diagnoseService.diagnose(args.issue);

        return {
          result,
          resultCount: Math.max(result.issues_found.length, 1)
        };
      })
  );

  server.tool(
    "memory_compact",
    "Compact Vega Memory by merging duplicates and archiving stale items.",
    {
      project: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "memory_compact", args, observer, async () => {
        const result = await Promise.resolve(
          compactService.compact(args.project, MCP_AUDIT_CONTEXT)
        );

        return {
          result,
          resultCount: result.merged + result.archived
        };
      })
  );

  if (compressionService !== undefined) {
    server.tool(
      "memory_compress",
      "Compress one memory or a batch of long memories with Ollama.",
      {
        memory_id: z.string().trim().min(1).optional(),
        project: z.string().trim().min(1).optional(),
        min_length: z.number().int().positive().optional()
      },
      async (args) =>
        runTool(repository, "memory_compress", args, observer, async () => {
          if (args.memory_id) {
            const result = await compressionService.compressMemory(args.memory_id);

            return {
              result: result as Record<string, unknown>,
              resultCount: result.applied ? 1 : 0
            };
          }

          const result = await compressionService.compressBatch(args.project, args.min_length);

          return {
            result: result as Record<string, unknown>,
            resultCount: result.compressed
          };
        })
    );
  }

  if (observer.enabled && observer.service !== undefined) {
    server.tool(
      "memory_observe",
      "Forward external tool execution data to Vega's passive observer.",
      {
        tool_name: z.string().trim().min(1),
        project: z.string().trim().min(1).optional(),
        input: z.unknown().optional(),
        output: z.unknown().optional()
      },
      async (args) =>
        runTool(repository, "memory_observe", args, { enabled: false }, async () => {
          const observed = observer.service?.shouldObserve(args.tool_name) ?? false;
          const stored_id = observed
            ? await observer.service?.observeToolOutput(
                args.tool_name,
                args.input,
                args.output,
                args.project ?? "global"
              )
            : null;

          return {
            result: {
              observed,
              stored_id
            },
            resultCount: stored_id ? 1 : 0
          };
        })
    );
  }

  server.tool(
    "wiki_ingest",
    "Ingest content into content sources and distilled memories.",
    {
      url: z.string().trim().url().optional(),
      content: z.string().trim().min(1).optional(),
      title: z.string().trim().min(1).optional(),
      tags: z.array(z.string().trim().min(1)).optional(),
      project: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "wiki_ingest", args, observer, async () => {
        const result = await ingestionService.ingest(args);

        return {
          result: {
            source_id: result.source_id,
            memories_created: result.memories_created,
            synthesis_queued: result.synthesis_queued
          },
          resultCount: result.memories_created + 1
        };
      })
  );

  server.tool(
    "wiki_search",
    "Search wiki pages using full-text search.",
    {
      query: z.string().trim().min(1),
      project: z.string().trim().min(1).optional(),
      page_type: z.enum(WIKI_PAGE_TYPES).optional(),
      limit: z.number().int().positive().default(10)
    },
    async (args) =>
      runTool(repository, "wiki_search", args, observer, async () => {
        const result = searchWikiPages(activeRepository, args);

        return {
          result,
          resultCount: result.length
        };
      })
  );

  server.tool(
    "wiki_read",
    "Read a wiki page and its backlinks.",
    {
      slug: z.string().trim().min(1)
    },
    async (args) =>
      runTool(repository, "wiki_read", args, observer, async () => {
        const result = pageManager.getPageWithBacklinks(args.slug);

        if (!result) {
          throw new Error(`Wiki page not found: ${args.slug}`);
        }

        return {
          result,
          resultCount: result.backlinks.length + 1
        };
      })
  );

  server.tool(
    "wiki_synthesize",
    "Synthesize a wiki page from related memories.",
    {
      topic: z.string().trim().min(1),
      project: z.string().trim().min(1).optional(),
      force: z.boolean().default(false)
    },
    async (args) =>
      runTool(repository, "wiki_synthesize", args, observer, async () => {
        const result = await synthesisEngine.synthesize(args.topic, args.project, args.force);

        if (result.action !== "unchanged" && result.page_id.length > 0) {
          const page = pageManager.getPage(result.page_id);

          if (page) {
            crossReferenceService.updateCrossReferences(page);
          }
        }

        return {
          result,
          resultCount: result.action === "unchanged" ? 0 : 1
        };
      })
  );

  server.tool(
    "wiki_list",
    "List wiki pages by project, type, or status.",
    {
      project: z.string().trim().min(1).optional(),
      page_type: z.enum(WIKI_PAGE_TYPES).optional(),
      status: z.enum(WIKI_PAGE_STATUSES).optional(),
      limit: z.number().int().positive().default(20)
    },
    async (args) =>
      runTool(repository, "wiki_list", args, observer, async () => {
        const result = pageManager
          .listPages({
            project: args.project,
            page_type: args.page_type,
            status: args.status,
            limit: args.limit
          })
          .map(serializeWikiPageListEntry);

        return {
          result,
          resultCount: result.length
        };
      })
  );

  server.tool(
    "wiki_publish",
    "Publish one wiki page or all published wiki pages to Notion, Obsidian, or both.",
    {
      slug: z.string().trim().min(1).optional(),
      target: z.enum(["notion", "obsidian", "all"]),
      all: z.boolean().default(false)
    },
    async (args) =>
      runTool(repository, "wiki_publish", args, observer, async () => {
        const result = await publishWikiPages(pageManager, args);

        return {
          result,
          resultCount: result.published_count
        };
      })
  );

  server.tool(
    "wiki_review",
    "Review a wiki page by approving, rejecting, or editing it.",
    {
      slug: z.string().trim().min(1),
      action: z.enum(WIKI_REVIEW_ACTIONS),
      content: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "wiki_review", args, observer, async () => {
        const result = reviewWikiPage(
          pageManager,
          crossReferenceService,
          args.slug,
          args.action,
          args.content
        );

        return {
          result,
          resultCount: 1
        };
      })
  );

  server.registerTool(
    ingestEventTool.name,
    {
      description: ingestEventTool.description,
      inputSchema: HOST_EVENT_ENVELOPE_V1.shape
    },
    async (args) =>
      runTool(repository, ingestEventTool.name, args, observer, async () => {
        const result = await ingestEventTool.invoke(args);

        return {
          result,
          resultCount: 1
        };
      })
  );

  server.registerTool(
    contextResolveTool.name,
    {
      description: contextResolveTool.description,
      inputSchema: INTENT_REQUEST_SCHEMA.shape
    },
    async (args) =>
      runTool(repository, contextResolveTool.name, args, observer, async () => {
        const result = await contextResolveTool.invoke(args);

        return {
          result,
          resultCount: 1
        };
      })
  );

  server.registerTool(
    usageAckTool.name,
    {
      description: usageAckTool.description,
      inputSchema: USAGE_ACK_SCHEMA.shape
    },
    async (args: unknown) =>
      runTool(repository, usageAckTool.name, args, observer, async () => {
        const checkpointId =
          typeof args === "object" &&
          args !== null &&
          typeof (args as { checkpoint_id?: unknown }).checkpoint_id === "string"
            ? (args as { checkpoint_id: string }).checkpoint_id
            : undefined;
        const checkpoint =
          checkpointId === undefined
            ? undefined
            : (() => {
                try {
                  return checkpointStore?.get(checkpointId);
                } catch {
                  return undefined;
                }
              })();
        const variant = resolveFlagVariant(featureFlags, USAGE_ACK_ECHO_SOURCE_KIND_FLAG_ID, "on", {
          surface: checkpoint?.surface ?? "unknown",
          intent: "ack",
          session_id: checkpoint?.session_id ?? undefined,
          project: checkpoint?.project ?? undefined
        });
        const result = await createUsageAckMcpTool(
          ackStore,
          checkpointStore,
          undefined,
          circuitBreaker,
          undefined,
          {
            echoed_source_kinds: variant === "on"
          }
        ).invoke(args);

        return {
          result,
          resultCount: 1
        };
      })
  );

  server.registerTool(
    reconciliationRunTool.name,
    {
      description: reconciliationRunTool.description,
      inputSchema: reconciliationRunTool.inputSchema
    },
    async (args: unknown) =>
      runTool(repository, reconciliationRunTool.name, args, observer, async () => {
        const result = await reconciliationRunTool.invoke(args);

        return {
          result,
          resultCount: 1
        };
      })
  );

  server.registerTool(
    "host_memory_file.refresh",
    {
      description: "Refresh the host memory file index.",
      inputSchema: {}
    },
    async (args: unknown) =>
      runTool<HostMemoryFileRefreshResult>(repository, "host_memory_file.refresh", args, observer, async () => {
        const startedAt = Date.now();

        if (activeRepository.db.isPostgres) {
          return {
            result: {
              schema_version: "1.0",
              refreshed_at: new Date().toISOString(),
              indexed_paths: 0,
              duration_ms: Date.now() - startedAt,
              degraded: "sqlite_only" as const
            },
            resultCount: 1
          };
        }

        if (refreshableHostMemoryFileAdapter === undefined || !refreshableHostMemoryFileAdapter.enabled) {
          return {
            result: {
              schema_version: "1.0",
              refreshed_at: new Date().toISOString(),
              indexed_paths: countHostMemoryFileEntries(activeRepository),
              duration_ms: Date.now() - startedAt,
              degraded: "adapter_disabled" as const
            },
            resultCount: 1
          };
        }

        refreshableHostMemoryFileAdapter.refreshIndex();

        return {
          result: {
            schema_version: "1.0",
            refreshed_at: new Date().toISOString(),
            indexed_paths: countHostMemoryFileEntries(activeRepository),
            duration_ms: Date.now() - startedAt
          },
          resultCount: 1
        };
      })
  );

  server.registerTool(
    "checkpoint.timeout_sweep",
    {
      description: "Sweep expired L1 checkpoints and classify timeout outcomes without throwing.",
      inputSchema: {
        max_per_run: z.number().int().positive().optional()
      }
    },
    async (args: unknown) =>
      runTool(repository, "checkpoint.timeout_sweep", args, observer, async () => {
        const parsedArgs = z
          .object({
            max_per_run: z.number().int().positive().optional()
          })
          .safeParse(args);
        const result = await sweepCheckpointTimeouts(activeRepository.db, {
          maxPerRun: parsedArgs.success ? parsedArgs.data.max_per_run : undefined
        });

        return {
          result,
          resultCount: result.records.length
        };
      })
  );

  server.registerTool(
    "backup.create",
    {
      description: "Create a local filesystem backup and emit a manifest evidence chain.",
      inputSchema: {
        label: z.string().trim().min(1).optional(),
        targets: z.array(z.string().trim().min(1)).optional()
      }
    },
    async (args: unknown) =>
      runTool<BackupCreateResult>(repository, "backup.create", args, observer, async () => {
        const parsedArgs = z
          .object({
            label: z.string().trim().min(1).optional(),
            targets: z.array(z.string().trim().min(1)).optional()
          })
          .safeParse(args);
        const configForRun =
          parsedArgs.success && parsedArgs.data.targets !== undefined
            ? {
                ...backupConfig,
                targets: parsedArgs.data.targets
              }
            : backupConfig;
        const result = await createBackup({
          config: configForRun,
          homeDir: backupHomeDir,
          label: parsedArgs.success ? parsedArgs.data.label : undefined
        });

        return {
          result: {
            schema_version: "1.0",
            ...result
          },
          resultCount: result.file_count
        };
      })
  );

  server.registerTool(
    "backup.restore",
    {
      description: "Restore a backup after manifest verification, with optional selective paths.",
      inputSchema: {
        backup_id: z.string().trim().min(1),
        mode: z.enum(["full", "selective"]),
        selective: z
          .object({
            files: z.array(z.string().trim().min(1)).min(1)
          })
          .optional(),
        dry_run: z.boolean().default(false),
        operator: z.string().trim().min(1).optional()
      }
    },
    async (args: unknown) =>
      runTool<BackupRestoreResult>(repository, "backup.restore", args, observer, async () => {
        const parsedArgs = z
          .object({
            backup_id: z.string().trim().min(1),
            mode: z.enum(["full", "selective"]),
            selective: z
              .object({
                files: z.array(z.string().trim().min(1)).min(1)
              })
              .optional(),
            dry_run: z.boolean().default(false),
            operator: z.string().trim().min(1).optional()
          })
          .parse(args);
        const result = await restoreBackup({
          backup_id: parsedArgs.backup_id,
          mode: parsedArgs.mode,
          selective: parsedArgs.selective,
          dryRun: parsedArgs.dry_run,
          homeDir: backupHomeDir
        });

        recordRestoreAudit(activeRepository.db, {
          backup_id: parsedArgs.backup_id,
          mode: parsedArgs.dry_run ? "drill" : parsedArgs.mode,
          operator: parsedArgs.operator ?? "system",
          before_state_sha256: result.before_state_sha256 ?? null,
          after_state_sha256: result.after_state_sha256 ?? null,
          restored_at: Date.parse(result.restored_at),
          verified: result.verified,
          mismatches: result.mismatches
        });

        return {
          result: {
            schema_version: "1.0",
            restored_at: result.restored_at,
            files_restored: result.files_restored,
            verified: result.verified,
            mismatches: result.mismatches,
            ...(result.degraded === undefined ? {} : { degraded: result.degraded })
          },
          resultCount: result.files_restored
        };
      })
  );

  server.registerTool(
    "backup.restore_drill",
    {
      description: "Verify backup manifest integrity without writing restored files.",
      inputSchema: {
        backup_id: z.string().trim().min(1)
      }
    },
    async (args: unknown) =>
      runTool<BackupRestoreDrillResult>(repository, "backup.restore_drill", args, observer, async () => {
        const parsedArgs = z
          .object({
            backup_id: z.string().trim().min(1)
          })
          .parse(args);
        const result = await runRestoreDrill({
          backup_id: parsedArgs.backup_id,
          homeDir: backupHomeDir
        });

        recordRestoreAudit(activeRepository.db, {
          backup_id: parsedArgs.backup_id,
          mode: "drill",
          operator: "system",
          before_state_sha256: null,
          after_state_sha256: null,
          restored_at: Date.now(),
          verified: result.verified,
          mismatches: result.mismatches
        });

        return {
          result: {
            schema_version: "1.0",
            verified: result.verified,
            mismatches: result.mismatches,
            ...(result.degraded === undefined ? {} : { degraded: result.degraded })
          },
          resultCount: result.mismatches.length
        };
      })
  );

  server.registerTool(
    "sunset.check",
    {
      description: "Evaluate sunset candidates from the checked-in registry.",
      inputSchema: {
        registry_path: z.string().trim().min(1).optional()
      }
    },
    async (args: unknown) =>
      runTool<SunsetCheckResult>(repository, "sunset.check", args, observer, async () => {
        const parsedArgs = z
          .object({
            registry_path: z.string().trim().min(1).optional()
          })
          .safeParse(args);
        const registryPath = parsedArgs.success ? parsedArgs.data.registry_path : undefined;
        const evaluatedAt = new Date().toISOString();
        const registry = inspectSunsetRegistry(registryPath);

        if (registry.degraded !== undefined) {
          return {
            result: {
              schema_version: "1.0",
              evaluated_at: evaluatedAt,
              candidates: [],
              degraded: registry.degraded
            },
            resultCount: 0
          };
        }

        const candidates = await evaluateSunsetCandidates(registry.candidates, {
          db: activeRepository.db,
          now: new Date(evaluatedAt),
          metricsQuery: async () => null
        });

        return {
          result: {
            schema_version: "1.0",
            evaluated_at: evaluatedAt,
            candidates
          },
          resultCount: candidates.length
        };
      })
  );

  server.registerTool(
    "alert.check",
    {
      description: "Evaluate alert rules from the checked-in registry.",
      inputSchema: {
        rules_path: z.string().trim().min(1).optional(),
        channels_path: z.string().trim().min(1).optional()
      }
    },
    async (args: unknown) =>
      runTool<AlertCheckResult>(repository, "alert.check", args, observer, async () => {
        const parsedArgs = z
          .object({
            rules_path: z.string().trim().min(1).optional(),
            channels_path: z.string().trim().min(1).optional()
          })
          .safeParse(args);
        const evaluatedAt = new Date().toISOString();
        const rulesResult = inspectAlertRules(
          parsedArgs.success ? parsedArgs.data.rules_path : undefined,
          process.env
        );
        const channelsResult = inspectAlertChannels(
          parsedArgs.success ? parsedArgs.data.channels_path : undefined,
          process.env
        );
        const degraded =
          rulesResult.degraded === "missing"
            ? ("rules_missing" as const)
            : channelsResult.degraded === "missing"
              ? ("channels_missing" as const)
              : rulesResult.degraded === "parse_error" || channelsResult.degraded === "parse_error"
                ? ("parse_error" as const)
                : undefined;
        const evaluations =
          rulesResult.degraded === undefined
            ? await evaluateAlertRules(rulesResult.rules, {
                metricsQuery: async () => null,
                now: () => new Date(evaluatedAt)
              })
            : [];

        return {
          result: {
            schema_version: "1.0",
            evaluated_at: evaluatedAt,
            evaluations,
            ...(degraded === undefined ? {} : { degraded })
          },
          resultCount: evaluations.length
        };
      })
  );

  server.registerTool(
    "alert.fire",
    {
      description: "Manually fire one alert rule and dispatch to its configured channels.",
      inputSchema: {
        rule_id: z.string().trim().min(1),
        reason: z.string().trim().min(1).optional()
      }
    },
    async (args: unknown) =>
      runTool<AlertFireResult>(repository, "alert.fire", args, observer, async () => {
        const parsedArgs = z
          .object({
            rule_id: z.string().trim().min(1),
            reason: z.string().trim().min(1).optional()
          })
          .safeParse(args);
        const firedAt = new Date();

        if (!parsedArgs.success) {
          return {
            result: {
              schema_version: "1.0",
              fired_at: firedAt.toISOString(),
              dispatch_status: {},
              degraded: "parse_error"
            },
            resultCount: 0
          };
        }

        const rulesResult = inspectAlertRules(DEFAULT_ALERT_RULES_PATH, process.env);
        const channelsResult = inspectAlertChannels(DEFAULT_ALERT_CHANNELS_PATH, process.env);

        if (rulesResult.degraded === "missing") {
          return {
            result: {
              schema_version: "1.0",
              fired_at: firedAt.toISOString(),
              dispatch_status: {},
              degraded: "rules_missing"
            },
            resultCount: 0
          };
        }

        if (rulesResult.degraded === "parse_error" || channelsResult.degraded === "parse_error") {
          return {
            result: {
              schema_version: "1.0",
              fired_at: firedAt.toISOString(),
              dispatch_status: {},
              degraded: "parse_error"
            },
            resultCount: 0
          };
        }

        const rule = rulesResult.rules.find((entry) => entry.id === parsedArgs.data.rule_id);
        if (rule === undefined) {
          return {
            result: {
              schema_version: "1.0",
              fired_at: firedAt.toISOString(),
              dispatch_status: {},
              degraded: "rule_not_found"
            },
            resultCount: 0
          };
        }

        const manualScheduler = new AlertScheduler({
          db: activeRepository.db,
          rules: rulesResult.rules,
          channels: channelsResult.channels,
          evaluator: async () => []
        });
        const dispatchStatus = await manualScheduler.fireRule(rule, {
          reason: parsedArgs.data.reason,
          firedAt
        });
        const degraded = channelsResult.degraded === "missing" ? "channels_missing" : undefined;

        return {
          result: {
            schema_version: "1.0",
            fired_at: firedAt.toISOString(),
            dispatch_status: dispatchStatus,
            ...(degraded === undefined ? {} : { degraded })
          },
          resultCount: Object.keys(dispatchStatus).length
        };
      })
  );

  for (const tool of [circuitBreakerStatusTool, circuitBreakerResetTool]) {
    const inputSchema =
      tool.name === "circuit_breaker_status"
        ? CIRCUIT_BREAKER_STATUS_INPUT_SCHEMA.shape
        : CIRCUIT_BREAKER_RESET_INPUT_SCHEMA.shape;

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema
      },
      async (args: unknown) =>
        runTool(repository, tool.name, args, observer, async () => {
          const result = await tool.invoke(args);

          return {
            result,
            resultCount: 1
          };
        })
    );
  }

  const featureFlagToolRegistrar = server as unknown as {
    registerTool(
      name: string,
      config: {
        description: string;
        inputSchema: unknown;
      },
      handler: (args: unknown) => Promise<CallToolResult>
    ): void;
  };

  // Register feature_flag.evaluate
  featureFlagToolRegistrar.registerTool(
    evaluateFlagTool.name,
    {
      description: evaluateFlagTool.description,
      inputSchema: evaluateFlagTool.inputSchema
    },
    async (args: unknown) =>
      runTool(repository, evaluateFlagTool.name, args, observer, async () => {
        const result = await evaluateFlagTool.invoke(args);

        return {
          result,
          resultCount: 1
        };
      })
  );

  // Register feature_flag.list
  featureFlagToolRegistrar.registerTool(
    listFlagsTool.name,
    {
      description: listFlagsTool.description,
      inputSchema: listFlagsTool.inputSchema
    },
    async (args: unknown) =>
      runTool(repository, listFlagsTool.name, args, observer, async () => {
        const result = await listFlagsTool.invoke(args);

        return {
          result,
          resultCount: 1
        };
      })
  );

  // Register feature_flag.metrics
  featureFlagToolRegistrar.registerTool(
    flagMetricsTool.name,
    {
      description: flagMetricsTool.description,
      inputSchema: flagMetricsTool.inputSchema
    },
    async (args: unknown) =>
      runTool(repository, flagMetricsTool.name, args, observer, async () => {
        const result = await flagMetricsTool.invoke(args);

        return {
          result,
          resultCount: 1
        };
      })
  );

  const candidateToolRegistrar = server as unknown as {
    registerTool(
      name: string,
      config: {
        description: string;
        inputSchema: unknown;
      },
      handler: (args: unknown) => Promise<CallToolResult>
    ): void;
  };

  for (const tool of [
    candidateCreateTool,
    candidateListTool,
    candidatePromoteTool,
    candidateDemoteTool,
    candidateEvaluateTool,
    candidateSweepTool
  ]) {
    const inputSchema =
      tool.name === "candidate_create"
        ? CANDIDATE_CREATE_SCHEMA.shape
        : tool.name === "candidate_list"
          ? CANDIDATE_LIST_SCHEMA.shape
          : tool.name === "candidate_promote"
            ? CANDIDATE_PROMOTE_SCHEMA.shape
            : tool.name === "candidate_demote"
              ? CANDIDATE_DEMOTE_SCHEMA.shape
              : tool.name === "candidate_evaluate"
                ? CANDIDATE_EVALUATE_SCHEMA.shape
                : CANDIDATE_SWEEP_SCHEMA.shape;

    candidateToolRegistrar.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema
      },
      async (args: unknown) =>
        runTool(repository, tool.name, args, observer, async () => {
          const result = await tool.invoke(args);

          return {
            result,
            resultCount:
              typeof result === "object" &&
              result !== null &&
              "records" in result &&
              Array.isArray((result as { records?: unknown }).records)
                ? (result as { records: unknown[] }).records.length
                : typeof result === "object" &&
                    result !== null &&
                    "results" in result &&
                    Array.isArray((result as { results?: unknown }).results)
                  ? (result as { results: unknown[] }).results.length
                : 1
          };
        })
    );
  }

  const closableServer = server as McpServer & {
    close(): Promise<void>;
  };
  const originalClose = closableServer.close.bind(closableServer);

  closableServer.close = async (): Promise<void> => {
    sunsetScheduler.stop();
    alertScheduler.stop();
    backupScheduler.stop();
    timeoutSweepScheduler.stop();
    refreshableHostMemoryFileAdapter?.dispose();
    await originalClose();
  };

  return closableServer;
}

export type VegaMCPTransport = StdioServerTransport;
