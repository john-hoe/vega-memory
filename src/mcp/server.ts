import { appendFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { VegaConfig } from "../config.js";
import { DiagnoseService } from "../core/diagnose.js";
import { getHealthReport } from "../core/health.js";
import { Repository } from "../db/repository.js";
import type {
  CompactResult,
  GraphQueryResult,
  HealthInfo,
  Memory,
  MemoryListFilters,
  MemorySource,
  MemoryType,
  MemoryUpdateParams,
  SearchOptions,
  SearchResult,
  SessionStartResult,
  StoreParams,
  StoreResult
} from "../core/types.js";

const MEMORY_TYPES = [
  "task_state",
  "preference",
  "project_context",
  "decision",
  "pitfall",
  "insight"
] as const satisfies readonly MemoryType[];

const MEMORY_SOURCES = ["auto", "explicit"] as const satisfies readonly MemorySource[];

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
  recent_unverified: result.recent_unverified.map(serializeMemory),
  conflicts: result.conflicts.map(serializeMemory),
  proactive_warnings: result.proactive_warnings,
  token_estimate: result.token_estimate
});

const serializeGraphQueryResult = (result: GraphQueryResult) => ({
  entity: result.entity,
  relations: result.relations,
  memories: result.memories.map(serializeMemory)
});

const resultCountForSessionStart = (result: SessionStartResult): number =>
  result.active_tasks.length +
  result.preferences.length +
  result.context.length +
  result.relevant.length +
  result.recent_unverified.length +
  result.conflicts.length;

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
    query(entityName: string, depth?: number): GraphQueryResult | Promise<GraphQueryResult>;
  };
  memoryService: {
    store(params: StoreParams): Promise<StoreResult>;
    update(id: string, updates: MemoryUpdateParams): Promise<void>;
    delete(id: string): Promise<void>;
  };
  recallService: {
    recall(query: string, options: SearchOptions): Promise<SearchResult[]>;
    listMemories(filters: MemoryListFilters): Memory[] | Promise<Memory[]>;
  };
  sessionService: {
    sessionStart(
      workingDirectory: string,
      taskHint?: string
    ): Promise<SessionStartResult>;
    sessionEnd(project: string, summary: string, completedTasks?: string[]): Promise<void>;
  };
  compactService: {
    compact(project?: string): CompactResult | Promise<CompactResult>;
  };
  compressionService?: {
    compressMemory(
      memoryId: string
    ): Promise<{ original_length: number; compressed_length: number }>;
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
  const observer = {
    enabled: config.observerEnabled,
    service: observerService
  };

  server.tool(
    "memory_graph",
    "Query entity relations and connected memories from Vega Memory.",
    {
      entity: z.string().trim().min(1),
      depth: z.number().int().min(0).default(1)
    },
    async (args) =>
      runTool(repository, "memory_graph", args, observer, async () => {
        const result = await Promise.resolve(graphService.query(args.entity, args.depth));

        return {
          result: serializeGraphQueryResult(result),
          resultCount: result.relations.length + result.memories.length
        };
      })
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
      source: z.enum(MEMORY_SOURCES).default("auto")
    },
    async (args) =>
      runTool(repository, "memory_store", args, observer, async () => {
        const result = await memoryService.store({
          ...args,
          project: args.project ?? "global"
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
            title: entry.memory.title,
            content: entry.memory.content,
            type: entry.memory.type,
            similarity: entry.similarity,
            project: entry.memory.project
          })),
          resultCount: result.length
        };
      })
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
      content: z.string().trim().min(1).optional(),
      importance: z.number().min(0).max(1).optional(),
      tags: z.array(z.string().trim().min(1)).optional()
    },
    async (args) =>
      runTool(repository, "memory_update", args, observer, async () => {
        await memoryService.update(args.id, {
          content: args.content,
          importance: args.importance,
          tags: args.tags
        });

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
        await memoryService.delete(args.id);

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
    "session_start",
    "Start a Vega Memory session for a working directory.",
    {
      working_directory: z.string().trim().min(1),
      task_hint: z.string().trim().min(1).optional()
    },
    async (args) =>
      runTool(repository, "session_start", args, observer, async () => {
        const result = await sessionService.sessionStart(
          args.working_directory,
          args.task_hint
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
        await sessionService.sessionEnd(args.project, args.summary, args.completed_tasks);

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
    "Return basic Vega Memory health information.",
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
        const result = await Promise.resolve(compactService.compact(args.project));

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
        project: z.string().trim().min(1).optional()
      },
      async (args) =>
        runTool(repository, "memory_compress", args, observer, async () => {
          if (args.memory_id) {
            const result = await compressionService.compressMemory(args.memory_id);

            return {
              result: result as Record<string, unknown>,
              resultCount: result.compressed_length < result.original_length ? 1 : 0
            };
          }

          const result = await compressionService.compressBatch(args.project);

          return {
            result: result as Record<string, unknown>,
            resultCount: result.compressed
          };
        })
    );
  }

  return server;
}

export type VegaMCPTransport = StdioServerTransport;
