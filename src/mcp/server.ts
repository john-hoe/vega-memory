import { appendFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  isConsolidationReportEnabled,
  isDeepRecallAvailable,
  isFactClaimsEnabled,
  type VegaConfig
} from "../config.js";
import { ArchiveService } from "../core/archive-service.js";
import { ConsolidationApprovalService } from "../core/consolidation-approval.js";
import { ConsolidationDashboardService } from "../core/consolidation-dashboard.js";
import { registerDefaultConsolidationDetectors } from "../core/consolidation-defaults.js";
import { ConsolidationReportEngine } from "../core/consolidation-report-engine.js";
import { ConsolidationScheduler } from "../core/consolidation-scheduler.js";
import { DiagnoseService } from "../core/diagnose.js";
import { FactClaimService } from "../core/fact-claim-service.js";
import { GraphReportService } from "../core/graph-report.js";
import { getHealthReport } from "../core/health.js";
import { TopicService } from "../core/topic-service.js";
import { Repository } from "../db/repository.js";
import { ContentDistiller } from "../ingestion/distiller.js";
import { ContentFetcher } from "../ingestion/fetcher.js";
import { IngestionService } from "../ingestion/service.js";
import { publishWikiPages } from "../publishing/service.js";
import { CrossReferenceService } from "../wiki/cross-reference.js";
import { PageManager } from "../wiki/page-manager.js";
import { reviewWikiPage, WIKI_REVIEW_ACTIONS } from "../wiki/review.js";
import { searchWikiPages } from "../wiki/search.js";
import { SynthesisEngine } from "../wiki/synthesis.js";
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
const SESSION_START_MODES = SESSION_START_MODE_VALUES;
const FACT_CLAIM_STATUSES = [
  "active",
  "expired",
  "suspected_expired",
  "conflict"
] as const satisfies readonly FactClaimStatus[];
const MCP_AUDIT_CONTEXT: AuditContext = { actor: "mcp", ip: null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const countMemories = (repository: Repository): number =>
  repository.listMemories({
    limit: 1_000_000
  }).length;

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
  title: memory.title,
  content: memory.content,
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
  accessed_projects: memory.accessed_projects
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
      mode?: SessionStartMode
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
  healthProvider
}: CreateMCPServerOptions): McpServer {
  const server = new McpServer({
    name: "vega-memory",
    version: "0.1.0"
  });
  const diagnoseService = new DiagnoseService(repository, config);
  const graphReportService = new GraphReportService(repository);
  const topicService = new TopicService(repository, config);
  const approvalService = new ConsolidationApprovalService(repository);
  const rawArchiveService = archiveService ?? new ArchiveService(repository, config);
  const claimsService = factClaimService ?? new FactClaimService(repository, config);
  const observer = {
    enabled: config.observerEnabled,
    service: observerService
  };
  const pageManager = new PageManager(repository);
  const synthesisEngine = new SynthesisEngine(repository, pageManager, config);
  const crossReferenceService = new CrossReferenceService(pageManager);
  const contentFetcher = new ContentFetcher();
  const contentDistiller = new ContentDistiller(config);
  const ingestionService = new IngestionService(
    contentFetcher,
    contentDistiller,
    pageManager,
    memoryService,
    synthesisEngine,
    config
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
        const engine = new ConsolidationReportEngine(repository, config);
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
        const dashboard = new ConsolidationDashboardService(repository, config);
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
        const scheduler = new ConsolidationScheduler(repository, config);
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
      status: z.enum(["pending", "approved", "rejected", "expired"]).default("pending"),
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
      preserve_raw: z.boolean().optional()
    },
    async (args) =>
      runTool(repository, "memory_store", args, observer, async () => {
        const result = await memoryService.store({
          ...args,
          project: args.project ?? "global",
          auditContext: MCP_AUDIT_CONTEXT
        });

        return {
          result,
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
      min_similarity: z.number().min(0).max(1).default(0.3)
    },
    async (args) =>
      runTool(repository, "memory_recall", args, observer, async () => {
        const result = await recallService.recall(args.query, {
          project: args.project,
          type: args.type,
          limit: args.limit,
          minSimilarity: args.min_similarity
        });

        return {
          result: result.map((entry) => ({
            id: entry.memory.id,
            type: entry.memory.type,
            project: entry.memory.project,
            title: entry.memory.title,
            content: entry.memory.content,
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
        await memoryService.update(
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
        await memoryService.delete(args.id, MCP_AUDIT_CONTEXT);

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
      mode: z.enum(SESSION_START_MODES).default("standard")
    },
    async (args) =>
      runTool(repository, "session_start", args, observer, async () => {
        const result = await sessionService.sessionStart(
          args.working_directory,
          args.task_hint,
          undefined,
          args.mode
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
        await sessionService.sessionEnd(
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
            ? await getHealthReport(repository, config)
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
        const result = searchWikiPages(repository, args);

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

  return server;
}

export type VegaMCPTransport = StdioServerTransport;
