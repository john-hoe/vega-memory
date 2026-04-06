import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { CompressionService } from "../core/compression.js";
import { DocGenerator } from "../core/doc-generator.js";
import { ExtractionService } from "../core/extraction.js";
import { MemoryService } from "../core/memory.js";
import { ObserverService } from "../core/observer.js";
import { QualityService } from "../core/quality.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { createMCPServer } from "../mcp/server.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  dbEncryption: false,
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
  type: "decision",
  project: "vega",
  title: "Stored Memory",
  content: "Use SQLite for memory storage.",
  embedding: null,
  importance: 0.5,
  source: "auto",
  tags: ["sqlite"],
  created_at: "2026-04-03T00:00:00.000Z",
  updated_at: "2026-04-03T00:00:00.000Z",
  accessed_at: "2026-04-03T00:00:00.000Z",
  status: "active",
  verified: "unverified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const installFetchMock = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): (() => void) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init);

  return () => {
    globalThis.fetch = originalFetch;
  };
};

test("CompressionService skips short memories (< 500 chars)", async () => {
  const repository = new Repository(":memory:");
  const compressionService = new CompressionService(repository, baseConfig);
  const content = "Short note that should not be compressed.";

  try {
    repository.createMemory(
      createStoredMemory({
        id: "short-memory",
        content
      })
    );

    const result = await compressionService.compressMemory("short-memory");

    assert.deepEqual(result, {
      original_length: content.length,
      compressed_length: content.length,
      applied: false
    });
    assert.equal(repository.getMemory("short-memory")?.content, content);
  } finally {
    repository.close();
  }
});

test("CompressionService ignores unusable summaries and leaves memory unchanged", async () => {
  const repository = new Repository(":memory:");
  const compressionService = new CompressionService(repository, baseConfig);
  const content = "A".repeat(800);
  const restoreFetch = installFetchMock((url) => {
    if (url.endsWith("/api/chat")) {
      return new Response(
        JSON.stringify({
          message: {
            content: "   "
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return new Response("not found", { status: 404 });
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "long-memory",
        content
      })
    );

    const result = await compressionService.compressMemory("long-memory");

    assert.deepEqual(result, {
      original_length: content.length,
      compressed_length: content.length,
      applied: false
    });
    assert.equal(repository.getMemory("long-memory")?.content, content);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("ExtractionService returns empty array when Ollama unavailable", async () => {
  const extractionService = new ExtractionService({
    ...baseConfig,
    ollamaBaseUrl: "http://localhost:99999"
  });

  assert.deepEqual(
    await extractionService.extractMemories("We decided to use SQLite.", "vega"),
    []
  );
});

test("ExtractionService filters unsupported types and duplicate candidates", async () => {
  const extractionService = new ExtractionService(baseConfig);
  const restoreFetch = installFetchMock((url) => {
    if (url.endsWith("/api/chat")) {
      return new Response(
        JSON.stringify({
          message: {
            content: `\`\`\`json
[
  {"type":"decision","title":"Use SQLite","content":"Use SQLite for local persistence.","tags":["sqlite","db"]},
  {"type":"decision","title":"Use SQLite","content":"Use SQLite for local persistence.","tags":["sqlite","db"]},
  {"type":"insight","title":"Unsupported","content":"Should not pass through.","tags":["pattern"]},
  {"type":"pitfall","title":"WAL checkpoint","content":"Checkpoint WAL before copying backups.","tags":["sqlite","backup"]}
]
\`\`\``
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return new Response("not found", { status: 404 });
  });

  try {
    const extracted = await extractionService.extractMemories(
      "We decided to use SQLite and learned to checkpoint WAL files.",
      "vega"
    );

    assert.deepEqual(extracted, [
      {
        type: "decision",
        title: "Use SQLite",
        content: "Use SQLite for local persistence.",
        tags: ["sqlite", "db"]
      },
      {
        type: "pitfall",
        title: "WAL checkpoint",
        content: "Checkpoint WAL before copying backups.",
        tags: ["sqlite", "backup"]
      }
    ]);
  } finally {
    restoreFetch();
  }
});

test("DocGenerator.generateProjectReadme produces valid markdown with sections", () => {
  const repository = new Repository(":memory:");
  const docGenerator = new DocGenerator(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "decision",
        type: "decision",
        title: "Use SQLite",
        content: "Use SQLite for local persistence."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "pitfall",
        type: "pitfall",
        title: "WAL backups",
        content: "Checkpoint WAL files before backups."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "task",
        type: "task_state",
        title: "Ship CLI",
        content: "Finish the CLI integration."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "context",
        type: "project_context",
        title: "Runtime",
        content: "The tool stores memories in SQLite."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "preference",
        type: "preference",
        project: "shared",
        scope: "global",
        title: "Concise output",
        content: "Prefer concise answers."
      })
    );

    const readme = docGenerator.generateProjectReadme("vega");

    assert.match(readme, /^# vega README/m);
    assert.match(readme, /^## Architecture Decisions/m);
    assert.match(readme, /^## Known Pitfalls/m);
    assert.match(readme, /^## Active Tasks/m);
    assert.match(readme, /^## Project Context/m);
    assert.match(readme, /^## Preferences/m);
  } finally {
    repository.close();
  }
});

test("DocGenerator.generateDecisionLog lists decisions chronologically", () => {
  const repository = new Repository(":memory:");
  const docGenerator = new DocGenerator(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "decision-early",
        title: "Early decision",
        content: "Choose SQLite first.",
        created_at: "2026-04-01T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "decision-late",
        title: "Later decision",
        content: "Add compression later.",
        created_at: "2026-04-02T00:00:00.000Z"
      })
    );

    const decisionLog = docGenerator.generateDecisionLog("vega");

    assert.equal(
      decisionLog.indexOf("Early decision") < decisionLog.indexOf("Later decision"),
      true
    );
  } finally {
    repository.close();
  }
});

test("DocGenerator excludes archived and conflict memories from generated docs", () => {
  const repository = new Repository(":memory:");
  const docGenerator = new DocGenerator(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "decision-active",
        type: "decision",
        title: "Active decision",
        content: "Keep active decisions in docs.",
        verified: "verified"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "decision-archived",
        type: "decision",
        title: "Archived decision",
        content: "This should not appear.",
        status: "archived",
        verified: "verified"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "pitfall-conflict",
        type: "pitfall",
        title: "Conflicting pitfall",
        content: "This should not appear either.",
        verified: "conflict"
      })
    );

    const readme = docGenerator.generateProjectReadme("vega");
    const decisionLog = docGenerator.generateDecisionLog("vega");
    const pitfallGuide = docGenerator.generatePitfallGuide("vega");

    assert.match(readme, /Active decision/);
    assert.doesNotMatch(readme, /Archived decision/);
    assert.match(decisionLog, /Active decision/);
    assert.doesNotMatch(decisionLog, /Archived decision/);
    assert.doesNotMatch(pitfallGuide, /Conflicting pitfall/);
  } finally {
    repository.close();
  }
});

test("QualityService.scoreMemory returns correct score for verified memory", () => {
  const repository = new Repository(":memory:");
  const qualityService = new QualityService(repository, baseConfig);

  try {
    const score = qualityService.scoreMemory({
      ...createStoredMemory({
        verified: "verified",
        updated_at: new Date().toISOString(),
        content: "x".repeat(200)
      }),
      access_count: 10
    });

    assert.equal(score.accuracy, 1);
    assert.equal(score.freshness, 1);
    assert.equal(score.usefulness, 1);
    assert.equal(score.completeness, 1);
    assert.equal(score.overall, 1);
  } finally {
    repository.close();
  }
});

test("QualityService.scoreMemory returns low score for rejected memory", () => {
  const repository = new Repository(":memory:");
  const qualityService = new QualityService(repository, baseConfig);

  try {
    const score = qualityService.scoreMemory({
      ...createStoredMemory({
        verified: "rejected",
        content: "Too short."
      }),
      access_count: 0
    });

    assert.equal(score.accuracy, 0);
    assert.equal(score.overall < 0.3, true);
  } finally {
    repository.close();
  }
});

test("QualityService.degradeLowQuality reduces importance", async () => {
  const repository = new Repository(":memory:");
  const qualityService = new QualityService(repository, baseConfig);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "low-quality",
        verified: "rejected",
        importance: 0.5,
        content: "Too short."
      })
    );

    const degraded = await qualityService.degradeLowQuality();

    assert.equal(degraded, 1);
    assert.equal(repository.getMemory("low-quality")?.importance, 0.4);
  } finally {
    repository.close();
  }
});

test("QualityService.degradeLowQuality respects the project filter", async () => {
  const repository = new Repository(":memory:");
  const qualityService = new QualityService(repository, baseConfig);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "low-quality-project",
        project: "vega",
        verified: "rejected",
        importance: 0.5,
        content: "Too short."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "low-quality-other",
        project: "other",
        verified: "rejected",
        importance: 0.5,
        content: "Too short."
      })
    );

    const degraded = await qualityService.degradeLowQuality("vega");

    assert.equal(degraded, 1);
    assert.equal(repository.getMemory("low-quality-project")?.importance, 0.4);
    assert.equal(repository.getMemory("low-quality-other")?.importance, 0.5);
  } finally {
    repository.close();
  }
});

test("ObserverService.shouldObserve returns true for Shell", () => {
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const observerService = new ObserverService(memoryService, {
    ...baseConfig,
    observerEnabled: true
  });

  try {
    assert.equal(observerService.shouldObserve("Shell"), true);
  } finally {
    repository.close();
  }
});

test("memory_observe tool forwards external tool output to ObserverService", async () => {
  const repository = new Repository(":memory:");
  const config = {
    ...baseConfig,
    observerEnabled: true
  };
  const restoreFetch = installFetchMock((url) => {
    if (url.endsWith("/api/embed")) {
      return new Response(JSON.stringify({ embeddings: [[0.2, 0.8]] }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    return new Response("not found", { status: 404 });
  });
  const memoryService = new MemoryService(repository, config);
  const observerService = new ObserverService(memoryService, config);
  const server = createMCPServer({
    repository,
    graphService: {
      query: () => ({
        entity: null,
        relations: [],
        memories: []
      })
    },
    memoryService,
    recallService: {
      recall: async () => [],
      listMemories: () => []
    },
    sessionService: {
      sessionStart: async () => ({
        project: "vega",
        active_tasks: [],
        preferences: [],
        context: [],
        relevant: [],
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
    observerService,
    config
  });

  try {
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              args: {
                tool_name: string;
                project: string;
                input: unknown;
                output: unknown;
              },
              extra: object
            ) => Promise<{ content: Array<{ text: string }> }>;
          }
        >;
      }
    )._registeredTools;

    const result = await registeredTools.memory_observe.handler(
      {
        tool_name: "exec_command",
        project: "vega",
        input: {
          cmd: "npm test"
        },
        output: {
          exitCode: 1,
          stderr: "Error: command failed"
        }
      },
      {}
    );
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      observed: boolean;
      stored_id: string | null;
    };
    const pitfalls = repository.listMemories({
      project: "vega",
      type: "pitfall",
      limit: 10
    });

    assert.equal(payload.observed, true);
    assert.ok(payload.stored_id);
    assert.equal(pitfalls.length, 1);
    assert.match(pitfalls[0]?.title ?? "", /Shell failure/);
  } finally {
    restoreFetch();
    repository.close();
    await server.close();
  }
});

test("memory_compress tool forwards min_length to batch compression", async () => {
  const repository = new Repository(":memory:");
  let receivedProject: string | undefined;
  let receivedMinLength: number | undefined;
  const server = createMCPServer({
    repository,
    graphService: {
      query: () => ({
        entity: null,
        relations: [],
        memories: []
      })
    },
    memoryService: {
      store: async () => ({ id: "noop", action: "created", title: "noop" }),
      update: async () => {},
      delete: async () => {}
    },
    recallService: {
      recall: async () => [],
      listMemories: () => []
    },
    sessionService: {
      sessionStart: async () => ({
        project: "vega",
        active_tasks: [],
        preferences: [],
        context: [],
        relevant: [],
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
    compressionService: {
      compressMemory: async () => ({
        original_length: 1000,
        compressed_length: 500,
        applied: true
      }),
      compressBatch: async (project?: string, minLength?: number) => {
        receivedProject = project;
        receivedMinLength = minLength;

        return {
          processed: 2,
          compressed: 1,
          saved_chars: 500
        };
      }
    },
    config: baseConfig
  });

  try {
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              args: {
                project: string;
                min_length: number;
              },
              extra: object
            ) => Promise<{ content: Array<{ text: string }> }>;
          }
        >;
      }
    )._registeredTools;

    const result = await registeredTools.memory_compress.handler(
      {
        project: "vega",
        min_length: 1200
      },
      {}
    );
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      processed: number;
      compressed: number;
      saved_chars: number;
    };

    assert.equal(receivedProject, "vega");
    assert.equal(receivedMinLength, 1200);
    assert.deepEqual(payload, {
      processed: 2,
      compressed: 1,
      saved_chars: 500
    });
  } finally {
    repository.close();
    await server.close();
  }
});
