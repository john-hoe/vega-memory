import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Command } from "commander";

import type { VegaConfig } from "../../config.js";
import { getDataDir } from "../../core/health.js";
import { KnowledgeGraphService } from "../../core/knowledge-graph.js";
import { MemoryService } from "../../core/memory.js";
import { RecallService } from "../../core/recall.js";
import { SessionService } from "../../core/session.js";
import { CompactService } from "../../core/compact.js";
import type { AuditContext } from "../../core/types.js";
import type { Repository } from "../../db/repository.js";
import { Repository as BenchmarkRepository } from "../../db/repository.js";
import { isOllamaAvailable } from "../../embedding/ollama.js";
import { createMCPServer } from "../../mcp/server.js";
import { SearchEngine } from "../../search/engine.js";

type BenchmarkSuite = "all" | "write" | "recall" | "concurrent";

interface BenchmarkResultRow {
  suite: "write" | "recall" | "concurrent";
  scenario: string;
  operations: number;
  total_ms: number;
  avg_ms: number;
  mode: string;
  db_path: string;
  notes: string;
}

interface BenchmarkRuntime {
  config: VegaConfig;
  repository: BenchmarkRepository;
  memoryService: MemoryService;
  recallService: RecallService;
  sessionService: SessionService;
  compactService: CompactService;
  close(): void;
}

const WRITE_ITERATIONS = 1_000;
const RECALL_QUERY_COUNT = 50;
const RECALL_DB_SIZES = [100, 500, 1_000] as const;
const CONCURRENT_PAIRS = 25;
const CLI_AUDIT_CONTEXT: AuditContext = { actor: "cli", ip: null };

const toFixedNumber = (value: number): number => Number(value.toFixed(2));

const createBenchmarkConfig = (config: VegaConfig, dbPath: string): VegaConfig => ({
  ...config,
  dbPath
});

const createBenchmarkRuntime = (config: VegaConfig, dbPath: string): BenchmarkRuntime => {
  const runtimeConfig = createBenchmarkConfig(config, dbPath);
  const repository = new BenchmarkRepository(runtimeConfig.dbPath);
  const searchEngine = new SearchEngine(repository, runtimeConfig);
  const memoryService = new MemoryService(repository, runtimeConfig);
  const recallService = new RecallService(repository, searchEngine, runtimeConfig);
  const sessionService = new SessionService(
    repository,
    memoryService,
    recallService,
    runtimeConfig
  );
  const compactService = new CompactService(repository, runtimeConfig);

  return {
    config: runtimeConfig,
    repository,
    memoryService,
    recallService,
    sessionService,
    compactService,
    close(): void {
      repository.close();
    }
  };
};

const createBenchmarkMemory = (index: number, project: string) => ({
  content:
    `Benchmark memory ${index + 1} for ${project}. ` +
    "Covers scheduler timing, sqlite-vec performance, sync recovery, and backup integrity.",
  type: "insight" as const,
  project,
  title: `Benchmark Memory ${index + 1}`,
  tags: ["benchmark", "sqlite", "scheduler"],
  source: "explicit" as const
});

const seedMemories = async (
  memoryService: MemoryService,
  targetCount: number,
  project: string,
  alreadySeeded = 0
): Promise<void> => {
  for (let index = alreadySeeded; index < targetCount; index += 1) {
    await memoryService.store({
      ...createBenchmarkMemory(index, project),
      auditContext: CLI_AUDIT_CONTEXT
    });
  }
};

const buildRecallQueries = (count: number): string[] =>
  Array.from(
    { length: RECALL_QUERY_COUNT },
    (_, index) => `Benchmark Memory ${(index % count) + 1}`
  );

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const extractMcpError = (result: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}): string | null => {
  if (result.isError !== true) {
    return null;
  }

  return result.content
    .filter((entry): entry is { type: string; text: string } => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
};

const buildReportPath = (config: VegaConfig): string =>
  join(getDataDir(config), "reports", `benchmark-${new Date().toISOString().slice(0, 10)}.md`);

const buildMarkdownReport = (
  suite: BenchmarkSuite,
  results: BenchmarkResultRow[],
  generatedAt: string
): string => {
  const lines = [
    "# Vega Memory Benchmark Report",
    "",
    `Generated: ${generatedAt}`,
    `Requested suite: ${suite}`,
    "",
    "| Suite | Scenario | Operations | Total (ms) | Avg (ms) | Mode | DB Path | Notes |",
    "| --- | --- | ---: | ---: | ---: | --- | --- | --- |"
  ];

  for (const row of results) {
    lines.push(
      `| ${row.suite} | ${row.scenario} | ${row.operations} | ${row.total_ms.toFixed(2)} | ${row.avg_ms.toFixed(2)} | ${row.mode} | ${row.db_path} | ${row.notes} |`
    );
  }

  if (results.length === 0) {
    lines.push("| none | none | 0 | 0.00 | 0.00 | n/a | n/a | n/a |");
  }

  lines.push("");
  return lines.join("\n");
};

const runWriteBenchmark = async (config: VegaConfig): Promise<BenchmarkResultRow[]> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-benchmark-write-"));
  const runtime = createBenchmarkRuntime(config, join(tempDir, "write.db"));

  try {
    const startedAt = performance.now();

    for (let index = 0; index < WRITE_ITERATIONS; index += 1) {
      await runtime.memoryService.store({
        ...createBenchmarkMemory(index, "benchmark-write"),
        auditContext: CLI_AUDIT_CONTEXT
      });
    }

    const total = performance.now() - startedAt;

    return [
      {
        suite: "write",
        scenario: `${WRITE_ITERATIONS} memory writes`,
        operations: WRITE_ITERATIONS,
        total_ms: toFixedNumber(total),
        avg_ms: toFixedNumber(total / WRITE_ITERATIONS),
        mode: "store",
        db_path: runtime.config.dbPath,
        notes: "isolated temp database"
      }
    ];
  } finally {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const runRecallBenchmark = async (config: VegaConfig): Promise<BenchmarkResultRow[]> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-benchmark-recall-"));
  const runtime = createBenchmarkRuntime(config, join(tempDir, "recall.db"));
  const project = "benchmark-recall";

  try {
    const results: BenchmarkResultRow[] = [];
    const ollamaAvailable = await isOllamaAvailable(runtime.config);
    let seeded = 0;

    for (const size of RECALL_DB_SIZES) {
      await seedMemories(runtime.memoryService, size, project, seeded);
      seeded = size;

      const queries = buildRecallQueries(size);
      const startedAt = performance.now();

      for (const query of queries) {
        if (ollamaAvailable) {
          await runtime.recallService.recall(query, {
            project,
            limit: 5,
            minSimilarity: 0
          });
        } else {
          runtime.repository.searchFTS(query, project);
        }
      }

      const total = performance.now() - startedAt;
      results.push({
        suite: "recall",
        scenario: `${queries.length} queries at ${size} memories`,
        operations: queries.length,
        total_ms: toFixedNumber(total),
        avg_ms: toFixedNumber(total / queries.length),
        mode: ollamaAvailable ? "hybrid" : "fts-only",
        db_path: runtime.config.dbPath,
        notes: `db_size=${size}`
      });
    }

    return results;
  } finally {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const runConcurrentBenchmark = async (config: VegaConfig): Promise<BenchmarkResultRow[]> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-benchmark-concurrent-"));
  const dbPath = join(tempDir, "concurrent.db");
  const cliRuntime = createBenchmarkRuntime(config, dbPath);
  const mcpRuntime = createBenchmarkRuntime(config, dbPath);
  const server = createMCPServer({
    repository: mcpRuntime.repository,
    graphService: new KnowledgeGraphService(mcpRuntime.repository),
    memoryService: mcpRuntime.memoryService,
    recallService: mcpRuntime.recallService,
    sessionService: mcpRuntime.sessionService,
    compactService: mcpRuntime.compactService,
    config: mcpRuntime.config
  });
  const client = new Client(
    {
      name: "vega-benchmark-client",
      version: "0.1.0"
    },
    {
      capabilities: {}
    }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const startedAt = performance.now();
    let lockingErrors = 0;

    for (let index = 0; index < CONCURRENT_PAIRS; index += 1) {
      const cliStore = cliRuntime.memoryService.store({
        ...createBenchmarkMemory(index, "benchmark-cli"),
        auditContext: CLI_AUDIT_CONTEXT
      });
      const mcpStore = client.callTool({
        name: "memory_store",
        arguments: createBenchmarkMemory(index + CONCURRENT_PAIRS, "benchmark-mcp")
      });
      const outcomes = await Promise.allSettled([cliStore, mcpStore]);

      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          const message = getErrorMessage(outcome.reason);

          if (/SQLITE_(BUSY|LOCKED)/.test(message)) {
            lockingErrors += 1;
          }

          throw new Error(message);
        }

        if ("content" in outcome.value) {
          const errorText = extractMcpError(outcome.value as { isError?: boolean; content: Array<{ type: string; text?: string }> });

          if (errorText !== null) {
            if (/SQLITE_(BUSY|LOCKED)/.test(errorText)) {
              lockingErrors += 1;
            }

            throw new Error(errorText);
          }
        }
      }
    }

    if (lockingErrors > 0) {
      throw new Error(`Detected ${lockingErrors} SQLite locking errors during concurrent benchmark`);
    }

    const total = performance.now() - startedAt;
    const operations = CONCURRENT_PAIRS * 2;

    return [
      {
        suite: "concurrent",
        scenario: `${CONCURRENT_PAIRS} paired CLI and MCP stores`,
        operations,
        total_ms: toFixedNumber(total),
        avg_ms: toFixedNumber(total / operations),
        mode: "cli+mcp",
        db_path: dbPath,
        notes: "locking_errors=0"
      }
    ];
  } finally {
    await client.close();
    await server.close();
    cliRuntime.close();
    mcpRuntime.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
};

export function registerBenchmarkCommand(
  program: Command,
  _repository: Repository,
  _memoryService: MemoryService,
  _recallService: RecallService,
  config: VegaConfig
): void {
  program
    .command("benchmark")
    .description("Run Vega Memory write, recall, and concurrency benchmarks")
    .option("--suite <suite>", "benchmark suite: all, write, recall, or concurrent", "all")
    .option("--report", "write a markdown report under data/reports")
    .action(async (options: { suite?: string; report?: boolean }) => {
      const suite = (options.suite ?? "all") as BenchmarkSuite;

      if (!["all", "write", "recall", "concurrent"].includes(suite)) {
        throw new Error(`Unsupported benchmark suite: ${options.suite}`);
      }

      const results: BenchmarkResultRow[] = [];

      if (suite === "all" || suite === "write") {
        results.push(...(await runWriteBenchmark(config)));
      }
      if (suite === "all" || suite === "recall") {
        results.push(...(await runRecallBenchmark(config)));
      }
      if (suite === "all" || suite === "concurrent") {
        results.push(...(await runConcurrentBenchmark(config)));
      }

      console.table(results);

      if (!options.report) {
        return;
      }

      const reportPath = buildReportPath(config);
      mkdirSync(join(getDataDir(config), "reports"), { recursive: true });
      writeFileSync(
        reportPath,
        buildMarkdownReport(suite, results, new Date().toISOString()),
        "utf8"
      );
      console.log(`report: ${reportPath}`);
    });
}
