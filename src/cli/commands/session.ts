import { Command } from "commander";

import { SessionService } from "../../core/session.js";
import {
  SESSION_START_MODE_VALUES,
  type AuditContext,
  type Memory,
  type SessionStartMode,
  type SessionStartResult
} from "../../core/types.js";

const CLI_AUDIT_CONTEXT: AuditContext = { actor: "cli", ip: null };

const parseCompleted = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

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

const serializeSessionStart = (result: SessionStartResult) => ({
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
  ...(result.deep_recall !== undefined ? { deep_recall: result.deep_recall } : {})
});

const printMemorySection = (label: string, memories: Memory[]): void => {
  console.log(`${label}: ${memories.length}`);
  for (const memory of memories) {
    console.log(`- ${memory.id} ${memory.title}`);
  }
};

export function registerSessionCommands(program: Command, sessionService: SessionService): void {
  program
    .command("session-start")
    .description("Start a session and load relevant memories")
    .option("--dir <path>", "working directory", process.cwd())
    .option("--hint <text>", "task hint")
    .option("--mode <mode>", "session preload mode", "standard")
    .option("--json", "print JSON")
    .action(
      async (options: { dir: string; hint?: string; mode: SessionStartMode; json?: boolean }) => {
        if (!SESSION_START_MODE_VALUES.includes(options.mode)) {
          throw new Error(
            `mode must be one of ${SESSION_START_MODE_VALUES.join(", ")}`
          );
        }

        const result = await sessionService.sessionStart(
          options.dir,
          options.hint,
          undefined,
          options.mode,
          {
            surface: "cli",
            integration: "vega-cli"
          }
        );

        if (options.json) {
          console.log(JSON.stringify(serializeSessionStart(result), null, 2));
          return;
        }

        console.log(`project: ${result.project}`);
        console.log(`token_estimate: ${Math.round(result.token_estimate)}`);
        printMemorySection("active_tasks", result.active_tasks);
        printMemorySection("preferences", result.preferences);
        printMemorySection("context", result.context);
        printMemorySection("relevant", result.relevant);
        console.log(`wiki_drafts_pending: ${result.wiki_drafts_pending}`);
        console.log(`relevant_wiki_pages: ${result.relevant_wiki_pages.length}`);
        for (const page of result.relevant_wiki_pages) {
          console.log(`- ${page.slug} ${page.title}`);
        }
        printMemorySection("recent_unverified", result.recent_unverified);
        printMemorySection("conflicts", result.conflicts);
        if (result.deep_recall !== undefined) {
          console.log(`deep_recall_results: ${result.deep_recall.results.length}`);
        }

        if (result.proactive_warnings.length > 0) {
          console.log("proactive_warnings:");
          for (const warning of result.proactive_warnings) {
            console.log(`- ${warning}`);
          }
        }
      }
    );

  program
    .command("session-end")
    .description("End a session and extract memories from the summary")
    .requiredOption("--project <project>", "project name")
    .requiredOption("--summary <text>", "session summary")
    .option("--completed <ids>", "comma-separated completed task ids", parseCompleted)
    .action(
      async (options: {
        project: string;
        summary: string;
        completed?: string[];
      }) => {
        await sessionService.sessionEnd(
          options.project,
          options.summary,
          options.completed,
          CLI_AUDIT_CONTEXT
        );
        console.log(
          `ended session for ${options.project} with ${options.completed?.length ?? 0} completed tasks`
        );
      }
    );
}
