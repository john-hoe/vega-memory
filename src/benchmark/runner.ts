import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { v4 as uuidv4 } from "uuid";

import {
  isDeepRecallAvailable,
  isFactClaimsEnabled,
  isRawArchiveEnabled,
  isTopicRecallEnabled,
  resolveFeatureFlags,
  type VegaConfig
} from "../config.js";
import { ArchiveService } from "../core/archive-service.js";
import { FactClaimService } from "../core/fact-claim-service.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { RegressionGuard } from "../core/regression-guard.js";
import { SessionService } from "../core/session.js";
import type {
  FactClaim,
  Memory,
  RawArchive,
  SearchOptions,
  SearchResult,
  SessionStartCanonicalMode,
  SessionStartMode
} from "../core/types.js";
import { Repository } from "../db/repository.js";
import { isOllamaAvailable } from "../embedding/ollama.js";
import { SearchEngine } from "../search/engine.js";

import {
  BENCHMARK_RECALL_SCALES,
  BENCHMARK_SESSION_LATENCY_MODES,
  BENCHMARK_SESSION_TOKEN_MODES,
  buildBenchmarkChecks,
  buildBenchmarkSummary,
  buildBenchmarkTrend,
  createBenchmarkRunId,
  getBenchmarkFiles,
  loadPreviousBenchmarkReport,
  summarizeLatency
} from "./report.js";
import type {
  BenchmarkRecallEngine,
  BenchmarkRecallQualityCase,
  BenchmarkRecallQualitySuite,
  BenchmarkReportWithoutComputed,
  BenchmarkRecallTokenMeasurement,
  BenchmarkReport,
  BenchmarkTokenSuite
} from "./types.js";

interface BenchmarkRuntime {
  config: VegaConfig;
  repository: Repository;
  searchEngine: SearchEngine;
  memoryService: MemoryService;
  recallService: RecallService;
  sessionService: SessionService;
  archiveService: ArchiveService;
  factClaimService: FactClaimService;
  regressionGuard: RegressionGuard;
  close(): void;
}

interface BenchmarkSeedCounts {
  session_start_memory_count: number;
  recall_quality_memory_count: number;
  deep_recall_archive_count: number;
}

const BENCHMARK_LATENCY_SAMPLE_COUNT = 12;
const BENCHMARK_DEEP_RECALL_SAMPLE_COUNT = 12;
const BENCHMARK_RECALL_LATENCY_QUERY_COUNT = 12;
const BENCHMARK_RECALL_LIMIT = 10;
const NOW = "2026-04-09T00:00:00.000Z";

const createBenchmarkConfig = (config: VegaConfig, dbPath: string): VegaConfig => ({
  ...config,
  dbPath,
  dbEncryption: false,
  features: {
    ...resolveFeatureFlags(config),
    factClaims: true,
    topicRecall: true,
    deepRecall: true,
    rawArchive: true
  }
});

const createRuntime = (config: VegaConfig, dbPath: string): BenchmarkRuntime => {
  const runtimeConfig = createBenchmarkConfig(config, dbPath);
  const repository = new Repository(runtimeConfig.dbPath);
  const searchEngine = new SearchEngine(repository, runtimeConfig);
  const regressionGuard = new RegressionGuard(repository, runtimeConfig);
  const memoryService = new MemoryService(repository, runtimeConfig);
  const recallService = new RecallService(repository, searchEngine, runtimeConfig, regressionGuard);
  const sessionService = new SessionService(
    repository,
    memoryService,
    recallService,
    runtimeConfig,
    null,
    regressionGuard,
    new FactClaimService(repository, runtimeConfig)
  );
  const archiveService = new ArchiveService(repository, runtimeConfig);
  const factClaimService = new FactClaimService(repository, runtimeConfig);

  return {
    config: runtimeConfig,
    repository,
    searchEngine,
    memoryService,
    recallService,
    sessionService,
    archiveService,
    factClaimService,
    regressionGuard,
    close(): void {
      repository.close();
    }
  };
};

const buildMemory = (
  id: string,
  overrides: Partial<Memory> = {}
): Memory => ({
  id,
  tenant_id: null,
  type: "decision",
  project: "benchmark",
  title: id,
  content: `${id} benchmark content`,
  summary: null,
  embedding: null,
  importance: 0.75,
  source: "explicit",
  tags: ["benchmark"],
  created_at: NOW,
  updated_at: NOW,
  accessed_at: NOW,
  access_count: 0,
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: [overrides.project ?? "benchmark"],
  ...overrides
});

const buildFactClaim = (
  id: string,
  sourceMemoryId: string,
  overrides: Partial<FactClaim>
): FactClaim => {
  const base: FactClaim = {
    id,
    tenant_id: null,
    project: "benchmark-quality",
    source_memory_id: sourceMemoryId,
    evidence_archive_id: null,
    canonical_key: `${overrides.subject ?? "subject"}|${overrides.predicate ?? "predicate"}|${overrides.claim_value ?? "value"}`,
    subject: "vega-memory",
    predicate: "database",
    claim_value: "sqlite",
    claim_text: "Vega Memory uses SQLite.",
    source: "hot_memory",
    status: "active",
    confidence: 0.9,
    valid_from: NOW,
    valid_to: null,
    temporal_precision: "day",
    invalidation_reason: null,
    created_at: NOW,
    updated_at: NOW
  };

  return {
    ...base,
    ...overrides,
    id,
    source_memory_id: sourceMemoryId
  };
};

const buildRawArchive = (
  id: string,
  project: string,
  content: string,
  title: string,
  sourceMemoryId: string | null = null
): RawArchive => ({
  id,
  tenant_id: null,
  project,
  source_memory_id: sourceMemoryId,
  archive_type: "document",
  title,
  source_uri: null,
  content,
  content_hash: `hash-${id}`,
  metadata: {
    benchmark: true,
    contains_raw: false
  },
  captured_at: NOW,
  created_at: NOW,
  updated_at: NOW
});

const createWorkingDirectory = (root: string, project: string, suffix: string): string => {
  const workingDirectory = join(root, suffix, project);
  mkdirSync(workingDirectory, { recursive: true });
  return workingDirectory;
};

const countSessionItems = (
  result: Awaited<ReturnType<SessionService["sessionStart"]>>
): number =>
  result.active_tasks.length +
  result.preferences.length +
  result.context.length +
  result.relevant.length +
  result.recent_unverified.length +
  result.conflicts.length +
  result.relevant_wiki_pages.length;

const executeRecall = async (
  runtime: BenchmarkRuntime,
  query: string,
  options: SearchOptions,
  recallEngine: BenchmarkRecallEngine
): Promise<SearchResult[]> => {
  if (recallEngine === "hybrid") {
    return runtime.recallService.recall(query, options);
  }

  return runtime.searchEngine.searchDetailed(query, null, options).results;
};

const seedSessionStartDataset = (runtime: BenchmarkRuntime, project: string): number => {
  const memories = [
    buildMemory("pref-1", {
      project: "shared",
      type: "preference",
      scope: "global",
      title: "Concise benchmark summaries",
      content: "Prefer concise benchmark summaries with threshold verdicts.",
      importance: 0.95
    }),
    buildMemory("pref-2", {
      project: "shared",
      type: "preference",
      scope: "global",
      title: "Persist benchmark reports",
      content: "Persist benchmark JSON and markdown outputs for trend analysis.",
      importance: 0.92
    }),
    buildMemory("task-1", {
      project,
      type: "task_state",
      title: "Token benchmark backlog",
      content: "Track token benchmark backlog for session start and recall metrics.",
      importance: 0.9
    }),
    buildMemory("task-2", {
      project,
      type: "task_state",
      title: "Latency benchmark backlog",
      content: "Track latency benchmark backlog for deep recall and session start.",
      importance: 0.88
    }),
    buildMemory("context-1", {
      project,
      type: "project_context",
      title: "Benchmark context storage",
      content: "Benchmark context stores token latency and recall quality evidence.",
      importance: 0.86
    }),
    buildMemory("context-2", {
      project,
      type: "project_context",
      title: "Benchmark threshold policy",
      content: "Benchmark threshold policy tracks recall precision latency and token budgets.",
      importance: 0.84
    }),
    buildMemory("context-3", {
      project,
      type: "project_context",
      title: "Benchmark report schema",
      content: "Benchmark report schema includes trend history output paths and pass flags.",
      importance: 0.82
    }),
    buildMemory("warn-1", {
      project,
      type: "pitfall",
      title: "Regression guard warning",
      content: "Regression guard warning: large recall bundles can inflate token usage.",
      verified: "conflict",
      importance: 0.8
    }),
    buildMemory("recent-1", {
      project,
      type: "decision",
      title: "Token benchmark implementation",
      content: "Token benchmark implementation measures L0 L1 L2 bundle sizes.",
      verified: "unverified",
      importance: 0.78
    }),
    buildMemory("recent-2", {
      project,
      type: "pitfall",
      title: "Latency benchmark cache pitfall",
      content: "Latency benchmark pitfall: session cache can hide real latency samples.",
      verified: "unverified",
      importance: 0.76
    })
  ];

  for (const memory of memories) {
    runtime.repository.createMemory(memory);
  }

  runtime.repository.createRawArchive(
    buildRawArchive(
      "session-archive-1",
      project,
      "concise summaries threshold verdicts benchmark report evidence",
      "Session benchmark evidence"
    )
  );
  runtime.repository.createRawArchive(
    buildRawArchive(
      "session-archive-2",
      project,
      "latency benchmark cache pitfall token bundle context evidence",
      "Latency benchmark evidence"
    )
  );

  return memories.length;
};

const seedRecallQualityDataset = (runtime: BenchmarkRuntime, project: string): number => {
  const memories = [
    buildMemory("db-1", {
      project,
      title: "SQLite WAL checkpoint benchmark",
      content: "sqlite wal checkpoint benchmark database latency token budget",
      tags: ["database", "sqlite", "checkpoint"],
      importance: 0.95
    }),
    buildMemory("db-2", {
      project,
      title: "SQLite checkpoint journal recovery",
      content: "sqlite checkpoint journal recovery benchmark database durability",
      tags: ["database", "sqlite", "journal"],
      importance: 0.93
    }),
    buildMemory("db-3", {
      project,
      title: "Token budget session context packing",
      content: "token budget session context packing sqlite database benchmark",
      tags: ["database", "token", "session"],
      importance: 0.91
    }),
    buildMemory("sync-1", {
      project,
      title: "Checkpoint replay queue recovery",
      content: "checkpoint replay queue recovery sync latency benchmark",
      tags: ["sync", "checkpoint", "queue"],
      importance: 0.89
    }),
    buildMemory("sync-2", {
      project,
      title: "Replication queue latency evidence",
      content: "replication queue latency evidence sync checkpoint recall",
      tags: ["sync", "replication", "queue"],
      importance: 0.87
    }),
    buildMemory("sched-1", {
      project,
      title: "Scheduler latency queue benchmark",
      content: "scheduler latency queue benchmark cron throughput",
      tags: ["scheduler", "latency", "queue"],
      importance: 0.85
    }),
    buildMemory("sched-2", {
      project,
      title: "Scheduler session budget retries",
      content: "scheduler session budget retries latency queue backoff",
      tags: ["scheduler", "session", "budget"],
      importance: 0.83
    }),
    buildMemory("noise-1", {
      project,
      title: "Generic benchmark report",
      content: "generic benchmark report output trend history metrics",
      tags: ["report"],
      importance: 0.5
    })
  ];

  for (const memory of memories) {
    runtime.repository.createMemory(memory);
  }

  const topicAssignments: Array<[string, string]> = [
    ["db-1", "database"],
    ["db-2", "database"],
    ["db-3", "database"],
    ["sync-1", "sync"],
    ["sync-2", "sync"],
    ["sched-1", "scheduler"],
    ["sched-2", "scheduler"]
  ];
  const timestamp = NOW;
  const topicIds = new Map<string, string>();

  for (const [, topicKey] of topicAssignments) {
    if (topicIds.has(topicKey)) {
      continue;
    }

    const topicId = `topic-${topicKey}`;
    runtime.repository.createTopic({
      id: topicId,
      tenant_id: null,
      project,
      topic_key: topicKey,
      version: 1,
      label: topicKey[0]!.toUpperCase() + topicKey.slice(1),
      kind: "topic",
      description: `${topicKey} benchmark topic`,
      source: "explicit",
      state: "active",
      supersedes_topic_id: null,
      created_at: timestamp,
      updated_at: timestamp
    });
    topicIds.set(topicKey, topicId);
  }

  for (const [memoryId, topicKey] of topicAssignments) {
    runtime.repository.createMemoryTopic({
      memory_id: memoryId,
      topic_id: topicIds.get(topicKey)!,
      source: "explicit",
      confidence: 1,
      status: "active",
      created_at: timestamp,
      updated_at: timestamp
    });
  }

  runtime.repository.createMemory(
    buildMemory("fact-source-1", {
      project,
      title: "Initial database decision",
      content: "The project originally used postgres for memory storage."
    })
  );
  runtime.repository.createMemory(
    buildMemory("fact-source-2", {
      project,
      title: "Database migration decision",
      content: "The project migrated to sqlite for memory storage."
    })
  );
  runtime.repository.createMemory(
    buildMemory("fact-source-3", {
      project,
      title: "Recall mode update",
      content: "The project uses token-aware bundles for recall."
    })
  );

  runtime.repository.createFactClaim(
    buildFactClaim("fact-1", "fact-source-1", {
      project,
      subject: "vega-memory",
      predicate: "database",
      claim_value: "postgres",
      claim_text: "Vega Memory uses Postgres.",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: "2026-03-01T00:00:00.000Z"
    })
  );
  runtime.repository.createFactClaim(
    buildFactClaim("fact-2", "fact-source-2", {
      project,
      subject: "vega-memory",
      predicate: "database",
      claim_value: "sqlite",
      claim_text: "Vega Memory uses SQLite.",
      valid_from: "2026-03-01T00:00:00.000Z"
    })
  );
  runtime.repository.createFactClaim(
    buildFactClaim("fact-3", "fact-source-3", {
      project,
      subject: "vega-memory",
      predicate: "recall-mode",
      claim_value: "token-aware",
      claim_text: "Recall uses token-aware bundles.",
      valid_from: "2026-02-01T00:00:00.000Z"
    })
  );

  return memories.length + 3;
};

const seedRecallLatencyDataset = (
  runtime: BenchmarkRuntime,
  project: string,
  count: number
): void => {
  for (let index = 0; index < count; index += 1) {
    runtime.repository.createMemory(
      buildMemory(`latency-${count}-${index}`, {
        project,
        title: `Latency memory ${count} ${index}`,
        content: `latency memory ${count} ${index} sqlite queue benchmark recall`,
        tags: ["latency", "benchmark", `scale-${count}`],
        importance: 0.6 + ((count - index) % 10) / 100
      })
    );
  }
};

const seedDeepRecallDataset = (runtime: BenchmarkRuntime, project: string, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    runtime.repository.createRawArchive(
      buildRawArchive(
        `deep-${index}`,
        project,
        `deep recall archive ${index} contains cold evidence for restore benchmark ${index}`,
        `Deep recall evidence ${index}`
      )
    );
  }
};

const runTokenSuite = async (
  config: VegaConfig,
  recallEngine: BenchmarkRecallEngine
): Promise<{ suite: BenchmarkTokenSuite; memoryCount: number }> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-benchmark-token-"));
  const runtime = createRuntime(config, join(tempDir, "token.db"));
  const project = "benchmark-token";
  const workingDirectory = createWorkingDirectory(tempDir, project, "workspace");

  try {
    const memoryCount = seedSessionStartDataset(runtime, project);
    const session_start = {
      L0: { token_estimate: 0, latency_ms: 0, item_count: 0 },
      L1: { token_estimate: 0, latency_ms: 0, item_count: 0 },
      L2: { token_estimate: 0, latency_ms: 0, item_count: 0 }
    } as BenchmarkTokenSuite["session_start"];

    for (const mode of BENCHMARK_SESSION_TOKEN_MODES) {
      const startedAt = performance.now();
      const result = await runtime.sessionService.sessionStart(
        workingDirectory,
        undefined,
        undefined,
        mode as SessionStartMode
      );
      session_start[mode] = {
        token_estimate: result.token_estimate,
        latency_ms: Number((performance.now() - startedAt).toFixed(3)),
        item_count: countSessionItems(result)
      };
    }

    const recallResults = await executeRecall(
      runtime,
      "sqlite checkpoint benchmark",
      {
        project,
        limit: 5,
        minSimilarity: 0,
        topic: "database"
      },
      recallEngine
    );
    const recall_result: BenchmarkRecallTokenMeasurement = {
      query: "sqlite checkpoint benchmark",
      engine: recallEngine,
      result_count: recallResults.length,
      token_estimate: runtime.regressionGuard.calculateRecallResultTokenEstimate(recallResults),
      top_result_ids: recallResults.map((result) => result.memory.id)
    };

    return {
      memoryCount,
      suite: {
        session_start,
        mode_deltas: [
          {
            from: "L0",
            to: "L1",
            delta_tokens: session_start.L1.token_estimate - session_start.L0.token_estimate,
            delta_ratio:
              session_start.L0.token_estimate === 0
                ? null
                : Number(
                    (
                      (session_start.L1.token_estimate - session_start.L0.token_estimate) /
                      session_start.L0.token_estimate
                    ).toFixed(3)
                  )
          },
          {
            from: "L1",
            to: "L2",
            delta_tokens: session_start.L2.token_estimate - session_start.L1.token_estimate,
            delta_ratio:
              session_start.L1.token_estimate === 0
                ? null
                : Number(
                    (
                      (session_start.L2.token_estimate - session_start.L1.token_estimate) /
                      session_start.L1.token_estimate
                    ).toFixed(3)
                  )
          }
        ],
        recall_result
      }
    };
  } finally {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const runRecallQualitySuite = async (
  config: VegaConfig,
  recallEngine: BenchmarkRecallEngine
): Promise<{ suite: BenchmarkRecallQualitySuite; memoryCount: number }> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-benchmark-quality-"));
  const runtime = createRuntime(config, join(tempDir, "quality.db"));
  const project = "benchmark-quality";

  try {
    const memoryCount = seedRecallQualityDataset(runtime, project);
    const cases: Array<{
      name: string;
      query: string;
      topic: string;
      expected_ids: string[];
    }> = [
      {
        name: "database-checkpoint",
        query: "sqlite checkpoint benchmark",
        topic: "database",
        expected_ids: ["db-1", "db-2"]
      },
      {
        name: "database-token-budget",
        query: "token budget session",
        topic: "database",
        expected_ids: ["db-3"]
      },
      {
        name: "sync-queue-latency",
        query: "queue latency checkpoint",
        topic: "sync",
        expected_ids: ["sync-1", "sync-2"]
      },
      {
        name: "scheduler-latency",
        query: "scheduler latency queue",
        topic: "scheduler",
        expected_ids: ["sched-1", "sched-2"]
      }
    ];
    const caseResults: BenchmarkRecallQualityCase[] = [];
    let hitCountAt5 = 0;
    let hitCountAt10 = 0;
    let expectedCount = 0;
    let unfilteredPrecisionAt5 = 0;
    let unfilteredPrecisionAt10 = 0;
    let topicFilteredPrecisionAt5 = 0;
    let topicFilteredPrecisionAt10 = 0;

    for (const definition of cases) {
      const unfiltered = await executeRecall(
        runtime,
        definition.query,
        {
          project,
          limit: BENCHMARK_RECALL_LIMIT,
          minSimilarity: 0
        },
        recallEngine
      );
      const topicFiltered = await executeRecall(
        runtime,
        definition.query,
        {
          project,
          limit: BENCHMARK_RECALL_LIMIT,
          minSimilarity: 0,
          topic: definition.topic
        },
        recallEngine
      );
      const unfilteredTop10 = unfiltered.slice(0, 10).map((result) => result.memory.id);
      const topicFilteredTop10 = topicFiltered.slice(0, 10).map((result) => result.memory.id);
      const hitsAt5 = definition.expected_ids.filter((id) => unfilteredTop10.slice(0, 5).includes(id))
        .length;
      const hitsAt10 = definition.expected_ids.filter((id) => unfilteredTop10.includes(id)).length;
      const unfilteredP5 = hitsAt5 / Math.max(1, Math.min(5, unfilteredTop10.length || 5));
      const unfilteredP10 = hitsAt10 / Math.max(1, Math.min(10, unfilteredTop10.length || 10));
      const filteredHitsAt5 = definition.expected_ids.filter((id) =>
        topicFilteredTop10.slice(0, 5).includes(id)
      ).length;
      const filteredHitsAt10 = definition.expected_ids.filter((id) =>
        topicFilteredTop10.includes(id)
      ).length;
      const filteredP5 =
        filteredHitsAt5 / Math.max(1, Math.min(5, topicFilteredTop10.length || 5));
      const filteredP10 =
        filteredHitsAt10 / Math.max(1, Math.min(10, topicFilteredTop10.length || 10));

      hitCountAt5 += hitsAt5;
      hitCountAt10 += hitsAt10;
      expectedCount += definition.expected_ids.length;
      unfilteredPrecisionAt5 += unfilteredP5;
      unfilteredPrecisionAt10 += unfilteredP10;
      topicFilteredPrecisionAt5 += filteredP5;
      topicFilteredPrecisionAt10 += filteredP10;

      caseResults.push({
        name: definition.name,
        query: definition.query,
        topic: definition.topic,
        expected_ids: definition.expected_ids,
        unfiltered_top10: unfilteredTop10,
        topic_filtered_top10: topicFilteredTop10,
        hits_at_5: hitsAt5,
        hits_at_10: hitsAt10,
        unfiltered_precision_at_5: Number(unfilteredP5.toFixed(3)),
        unfiltered_precision_at_10: Number(unfilteredP10.toFixed(3)),
        topic_filtered_precision_at_5: Number(filteredP5.toFixed(3)),
        topic_filtered_precision_at_10: Number(filteredP10.toFixed(3))
      });
    }

    const factClaimCases = [
      {
        name: "database-before-migration",
        timestamp: "2026-02-15T00:00:00.000Z",
        subject: "vega-memory",
        predicate: "database",
        expected_values: ["postgres"]
      },
      {
        name: "database-after-migration",
        timestamp: "2026-04-15T00:00:00.000Z",
        subject: "vega-memory",
        predicate: "database",
        expected_values: ["sqlite"]
      },
      {
        name: "recall-mode-current",
        timestamp: "2026-04-15T00:00:00.000Z",
        subject: "vega-memory",
        predicate: "recall-mode",
        expected_values: ["token-aware"]
      }
    ].map((definition) => {
      const actualValues = runtime.factClaimService
        .asOfQuery(project, definition.timestamp, definition.subject, definition.predicate)
        .map((claim) => claim.claim_value)
        .sort();
      const expectedValues = [...definition.expected_values].sort();
      const passed = JSON.stringify(actualValues) === JSON.stringify(expectedValues);

      return {
        ...definition,
        actual_values: actualValues,
        passed
      };
    });

    return {
      memoryCount,
      suite: {
        recall_at_5: Number((hitCountAt5 / expectedCount).toFixed(3)),
        recall_at_10: Number((hitCountAt10 / expectedCount).toFixed(3)),
        unfiltered_precision_at_5: Number((unfilteredPrecisionAt5 / cases.length).toFixed(3)),
        unfiltered_precision_at_10: Number((unfilteredPrecisionAt10 / cases.length).toFixed(3)),
        topic_filtered_precision_at_5: Number(
          (topicFilteredPrecisionAt5 / cases.length).toFixed(3)
        ),
        topic_filtered_precision_at_10: Number(
          (topicFilteredPrecisionAt10 / cases.length).toFixed(3)
        ),
        precision_delta_at_5: Number(
          ((topicFilteredPrecisionAt5 - unfilteredPrecisionAt5) / cases.length).toFixed(3)
        ),
        precision_delta_at_10: Number(
          ((topicFilteredPrecisionAt10 - unfilteredPrecisionAt10) / cases.length).toFixed(3)
        ),
        fact_claim_accuracy: Number(
          (
            factClaimCases.filter((factClaimCase) => factClaimCase.passed).length /
            factClaimCases.length
          ).toFixed(3)
        ),
        cases: caseResults,
        fact_claim_cases: factClaimCases
      }
    };
  } finally {
    runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
};

const runLatencySuite = async (
  config: VegaConfig,
  recallEngine: BenchmarkRecallEngine
): Promise<{ suite: BenchmarkReport["suites"]["latency"]; seedCounts: Pick<BenchmarkSeedCounts, "deep_recall_archive_count"> }> => {
  const sessionTempDir = mkdtempSync(join(tmpdir(), "vega-benchmark-session-latency-"));
  const sessionRuntime = createRuntime(config, join(sessionTempDir, "session.db"));
  const sessionProject = "benchmark-session-latency";
  const recallSummaries: BenchmarkReport["suites"]["latency"]["recall"] = {};
  const sessionLatencies = {
    L0: [] as number[],
    L1: [] as number[],
    L2: [] as number[],
    L3: [] as number[]
  };

  try {
    seedSessionStartDataset(sessionRuntime, sessionProject);

    for (const mode of BENCHMARK_SESSION_LATENCY_MODES) {
      for (let sample = 0; sample < BENCHMARK_LATENCY_SAMPLE_COUNT; sample += 1) {
        const workingDirectory = createWorkingDirectory(
          sessionTempDir,
          sessionProject,
          `session-${mode}-${sample}`
        );
        const startedAt = performance.now();
        await sessionRuntime.sessionService.sessionStart(
          workingDirectory,
          undefined,
          undefined,
          mode as SessionStartMode
        );
        sessionLatencies[mode].push(performance.now() - startedAt);
      }
    }

    for (const scale of BENCHMARK_RECALL_SCALES) {
      const recallTempDir = mkdtempSync(join(tmpdir(), `vega-benchmark-recall-${scale}-`));
      const recallRuntime = createRuntime(config, join(recallTempDir, "recall.db"));
      const recallProject = `benchmark-recall-${scale}`;
      const latencies: number[] = [];

      try {
        seedRecallLatencyDataset(recallRuntime, recallProject, scale);

        for (let sample = 0; sample < BENCHMARK_RECALL_LATENCY_QUERY_COUNT; sample += 1) {
          const memoryIndex = (sample * 17) % scale;
          const query = `latency memory ${scale} ${memoryIndex}`;
          const startedAt = performance.now();
          await executeRecall(
            recallRuntime,
            query,
            {
              project: recallProject,
              limit: 5,
              minSimilarity: 0
            },
            recallEngine
          );
          latencies.push(performance.now() - startedAt);
        }

        recallSummaries[String(scale)] = {
          ...summarizeLatency(latencies),
          engine: recallEngine,
          memory_count: scale
        };
      } finally {
        recallRuntime.close();
        rmSync(recallTempDir, { recursive: true, force: true });
      }
    }

    const deepTempDir = mkdtempSync(join(tmpdir(), "vega-benchmark-deep-recall-"));
    const deepRuntime = createRuntime(config, join(deepTempDir, "deep.db"));
    const deepProject = "benchmark-deep-recall";
    const deepLatencies: number[] = [];
    const archiveCount = 30;

    try {
      seedDeepRecallDataset(deepRuntime, deepProject, archiveCount);

      for (let sample = 0; sample < BENCHMARK_DEEP_RECALL_SAMPLE_COUNT; sample += 1) {
        const startedAt = performance.now();
        deepRuntime.archiveService.deepRecall({
          query: `deep recall archive ${sample % archiveCount}`,
          project: deepProject,
          limit: 5,
          include_content: true,
          include_metadata: false,
          inject_into_session: false
        });
        deepLatencies.push(performance.now() - startedAt);
      }

      return {
        seedCounts: {
          deep_recall_archive_count: archiveCount
        },
        suite: {
          session_start: {
            L0: summarizeLatency(sessionLatencies.L0),
            L1: summarizeLatency(sessionLatencies.L1),
            L2: summarizeLatency(sessionLatencies.L2),
            L3: summarizeLatency(sessionLatencies.L3)
          },
          recall: recallSummaries,
          deep_recall: {
            ...summarizeLatency(deepLatencies),
            archive_count: archiveCount
          }
        }
      };
    } finally {
      deepRuntime.close();
      rmSync(deepTempDir, { recursive: true, force: true });
    }
  } finally {
    sessionRuntime.close();
    rmSync(sessionTempDir, { recursive: true, force: true });
  }
};

export const runBenchmarkSuite = async (config: VegaConfig): Promise<BenchmarkReport> => {
  const runId = createBenchmarkRunId();
  const outputFiles = getBenchmarkFiles(config, runId);
  const ollamaAvailable = await isOllamaAvailable(config);
  const recallEngine: BenchmarkRecallEngine = ollamaAvailable ? "hybrid" : "fts-only";

  const token = await runTokenSuite(config, recallEngine);
  const recallQuality = await runRecallQualitySuite(config, recallEngine);
  const latency = await runLatencySuite(config, recallEngine);

  const reportWithoutChecks: BenchmarkReportWithoutComputed = {
    schema_version: 1 as const,
    run_id: runId,
    generated_at: new Date().toISOString(),
    output_dir: outputFiles.outputDir,
    environment: {
      recall_engine: recallEngine,
      ollama_available: ollamaAvailable,
      token_budget: config.tokenBudget,
      db_path: config.dbPath,
      features: {
        fact_claims: isFactClaimsEnabled(createBenchmarkConfig(config, config.dbPath)),
        topic_recall: isTopicRecallEnabled(createBenchmarkConfig(config, config.dbPath)),
        deep_recall: isDeepRecallAvailable(createBenchmarkConfig(config, config.dbPath)),
        raw_archive: isRawArchiveEnabled(createBenchmarkConfig(config, config.dbPath))
      }
    },
    datasets: {
      session_start_memory_count: token.memoryCount,
      recall_quality_memory_count: recallQuality.memoryCount,
      recall_quality_case_count: recallQuality.suite.cases.length,
      recall_latency_scales: [...BENCHMARK_RECALL_SCALES],
      deep_recall_archive_count: latency.seedCounts.deep_recall_archive_count
    },
    suites: {
      token: token.suite,
      recall_quality: recallQuality.suite,
      latency: latency.suite
    },
    files: {
      json: outputFiles.json,
      markdown: outputFiles.markdown
    }
  };
  const checks = buildBenchmarkChecks(reportWithoutChecks, config);
  const summary = buildBenchmarkSummary(checks);
  const previous = loadPreviousBenchmarkReport(config, runId);
  const report: BenchmarkReport = {
    ...reportWithoutChecks,
    checks,
    summary,
    trend: buildBenchmarkTrend(previous, {
      ...reportWithoutChecks,
      checks,
      summary
    })
  };

  return report;
};
