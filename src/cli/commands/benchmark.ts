import { performance } from "node:perf_hooks";

import { Command } from "commander";

import type { VegaConfig } from "../../config.js";
import { MemoryService } from "../../core/memory.js";
import { RecallService } from "../../core/recall.js";
import type { Repository } from "../../db/repository.js";
import { isOllamaAvailable } from "../../embedding/ollama.js";

type BenchmarkSuite = "all" | "write" | "recall";

interface BenchmarkResultRow {
  suite: "write" | "recall";
  operations: number;
  total_ms: number;
  avg_ms: number;
  mode: string;
  db_path: string;
}

const WRITE_ITERATIONS = 100;
const RECALL_ITERATIONS = 20;

const toFixedNumber = (value: number): number => Number(value.toFixed(2));

const buildRecallQueries = (repository: Repository): string[] => {
  const memories = repository.listMemories({
    limit: RECALL_ITERATIONS,
    sort: "access_count DESC"
  });

  if (memories.length === 0) {
    return Array.from({ length: RECALL_ITERATIONS }, (_, index) => `benchmark query ${index + 1}`);
  }

  return Array.from({ length: RECALL_ITERATIONS }, (_, index) => {
    const memory = memories[index % memories.length];
    return memory.title;
  });
};

const runWriteBenchmark = async (
  memoryService: MemoryService,
  config: VegaConfig
): Promise<BenchmarkResultRow> => {
  const startedAt = performance.now();

  for (let index = 0; index < WRITE_ITERATIONS; index += 1) {
    await memoryService.store({
      content: `Benchmark write memory ${index + 1} at ${new Date().toISOString()}`,
      type: "insight",
      project: "benchmark-write",
      title: `Benchmark Write ${index + 1}`,
      source: "explicit"
    });
  }

  const total = performance.now() - startedAt;

  return {
    suite: "write",
    operations: WRITE_ITERATIONS,
    total_ms: toFixedNumber(total),
    avg_ms: toFixedNumber(total / WRITE_ITERATIONS),
    mode: "store",
    db_path: config.dbPath
  };
};

const runRecallBenchmark = async (
  repository: Repository,
  recallService: RecallService,
  config: VegaConfig
): Promise<BenchmarkResultRow> => {
  const queries = buildRecallQueries(repository);
  const ollamaAvailable = await isOllamaAvailable(config);
  const startedAt = performance.now();

  for (const query of queries) {
    if (ollamaAvailable) {
      await recallService.recall(query, {
        limit: 5,
        minSimilarity: 0
      });
    } else {
      repository.searchFTS(query);
    }
  }

  const total = performance.now() - startedAt;

  return {
    suite: "recall",
    operations: queries.length,
    total_ms: toFixedNumber(total),
    avg_ms: toFixedNumber(total / queries.length),
    mode: ollamaAvailable ? "hybrid" : "fts-only",
    db_path: config.dbPath
  };
};

export function registerBenchmarkCommand(
  program: Command,
  repository: Repository,
  memoryService: MemoryService,
  recallService: RecallService,
  config: VegaConfig
): void {
  program
    .command("benchmark")
    .description("Run Vega Memory write and recall benchmarks")
    .option("--suite <suite>", "benchmark suite: all, write, or recall", "all")
    .action(async (options: { suite?: string }) => {
      const suite = (options.suite ?? "all") as BenchmarkSuite;

      if (!["all", "write", "recall"].includes(suite)) {
        throw new Error(`Unsupported benchmark suite: ${options.suite}`);
      }

      const results: BenchmarkResultRow[] = [];

      if (suite === "all" || suite === "write") {
        results.push(await runWriteBenchmark(memoryService, config));
      }
      if (suite === "all" || suite === "recall") {
        results.push(await runRecallBenchmark(repository, recallService, config));
      }

      console.table(results);
    });
}
