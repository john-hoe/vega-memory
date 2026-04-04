import { existsSync, statSync, appendFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { VegaConfig } from "../config.js";
import { DiagnoseService } from "../core/diagnose.js";
import { isOllamaAvailable } from "../embedding/ollama.js";
import { Repository } from "../db/repository.js";
import type {
  CompactResult,
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

const countMemories = (repository: Repository): number =>
  repository.listMemories({
    limit: 1_000_000
  }).length;

const getDatabaseSizeBytes = (dbPath: string): number => {
  if (dbPath === ":memory:") {
    return 0;
  }

  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((total, path) => {
    if (!existsSync(path)) {
      return total;
    }

    return total + statSync(path).size;
  }, 0);
};

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

const runTool = async <T>(
  repository: Repository,
  operation: string,
  execute: () => Promise<{ result: T; resultCount: number }>
): Promise<CallToolResult> => {
  dbg(`runTool called: ${operation}`);
  const startedAt = Date.now();
  let resultCount = 0;

  try {
    const executed = await execute();
    resultCount = executed.resultCount;
    dbg(`runTool ${operation} OK in ${Date.now() - startedAt}ms`);
    return toTextResult(executed.result);
  } catch (error) {
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
  config: VegaConfig;
  healthProvider?: () => Promise<HealthInfo>;
}

export function createMCPServer({
  repository,
  memoryService,
  recallService,
  sessionService,
  compactService,
  config,
  healthProvider
}: CreateMCPServerOptions): McpServer {
  const server = new McpServer({
    name: "vega-memory",
    version: "0.1.0"
  });
  const diagnoseService = new DiagnoseService(repository, config);

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
      runTool(repository, "memory_store", async () => {
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
      runTool(repository, "memory_recall", async () => {
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
      runTool(repository, "memory_list", async () => {
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
      runTool(repository, "memory_update", async () => {
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
      runTool(repository, "memory_delete", async () => {
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
      runTool(repository, "session_start", async () => {
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
      runTool(repository, "session_end", async () => {
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
      runTool(repository, "memory_health", async () => {
        const result =
          healthProvider === undefined
            ? {
                memory_count: countMemories(repository),
                db_size_bytes: getDatabaseSizeBytes(config.dbPath),
                ollama_available: await isOllamaAvailable(config)
              }
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
      runTool(repository, "memory_diagnose", async () => {
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
      runTool(repository, "memory_compact", async () => {
        const result = await Promise.resolve(compactService.compact(args.project));

        return {
          result,
          resultCount: result.merged + result.archived
        };
      })
  );

  return server;
}

export type VegaMCPTransport = StdioServerTransport;
