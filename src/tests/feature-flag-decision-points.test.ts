import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import { Repository } from "../db/repository.js";
import { createAPIServer } from "../api/server.js";
import { rank } from "../retrieval/ranker.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import { SourceRegistry } from "../retrieval/sources/registry.js";
import type { SourceAdapter, SourceRecord } from "../retrieval/sources/types.js";
import { SearchEngine } from "../search/engine.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { CompactService } from "../core/compact.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-04-21T12:00:00.000Z");

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  cacheDbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:99999",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  apiPort: 0,
  apiKey: "feature-flag-secret",
  mode: "server",
  serverUrl: undefined,
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  dbEncryption: false
};

interface ApiHarness {
  repository: Repository;
  request(path: string, init?: RequestInit): Promise<Response>;
  cleanup(): Promise<void>;
}

function writeFlagRegistry(flagsBlock: string): { cleanup(): void; path: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-feature-flag-registry-"));
  const registryPath = join(tempDir, "docs", "feature-flags", "flags.yaml");
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${flagsBlock.trim()}\n`, "utf8");
  return {
    path: registryPath,
    cleanup(): void {
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function withRegistryPath<T>(registryPath: string, fn: () => T): T {
  const previous = process.env.VEGA_FEATURE_FLAG_REGISTRY_PATH;
  process.env.VEGA_FEATURE_FLAG_REGISTRY_PATH = registryPath;

  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.VEGA_FEATURE_FLAG_REGISTRY_PATH;
    } else {
      process.env.VEGA_FEATURE_FLAG_REGISTRY_PATH = previous;
    }
  }
}

const defaultFlagsYaml = `
flags:
  - id: retrieval-queryless-bootstrap
    description: Gate the queryless bootstrap wide-recall path. Off reverts to empty-bundle-on-empty-query (pre-B5 behavior).
    variants:
      on: true
      off: false
    default: on
    matchers:
      surfaces: "*"
      intents: ["bootstrap"]
      traffic_percent: 100
    bucketing:
      seed_field: session_id

  - id: usage-ack-echo-source-kind
    description: Gate the echoed_source_kinds[] field in usage.ack response. Off omits the echo (compat for older consumers).
    variants:
      on: true
      off: false
    default: on
    matchers:
      surfaces: "*"
      intents: "*"
      traffic_percent: 100
    bucketing:
      seed_field: session_id

  - id: ranker-recency-halflife-14d
    description: When on, switches ranker recency decay half-life from 7 days to 14 days. Retention-sensitivity canary.
    variants:
      on: true
      off: false
    default: off
    matchers:
      surfaces: "*"
      intents: "*"
      traffic_percent: 0
    bucketing:
      seed_field: session_id
`;

const bootstrapFlagOffYaml = `
flags:
  - id: retrieval-queryless-bootstrap
    description: Gate the queryless bootstrap wide-recall path. Off reverts to empty-bundle-on-empty-query (pre-B5 behavior).
    variants:
      on: true
      off: false
    default: off
    matchers:
      surfaces: "*"
      intents: ["bootstrap"]
      traffic_percent: 0
    bucketing:
      seed_field: session_id
`;

const usageAckFlagOffYaml = `
flags:
  - id: usage-ack-echo-source-kind
    description: Gate the echoed_source_kinds[] field in usage.ack response. Off omits the echo (compat for older consumers).
    variants:
      on: true
      off: false
    default: off
    matchers:
      surfaces: "*"
      intents: "*"
      traffic_percent: 0
    bucketing:
      seed_field: session_id
`;

const rankerFlagOnYaml = `
flags:
  - id: ranker-recency-halflife-14d
    description: When on, switches ranker recency decay half-life from 7 days to 14 days. Retention-sensitivity canary.
    variants:
      on: true
      off: false
    default: off
    matchers:
      surfaces: "*"
      intents: "*"
      traffic_percent: 100
    bucketing:
      seed_field: session_id
`;

function createRequest(overrides: Partial<IntentRequest> = {}): IntentRequest {
  return {
    intent: "bootstrap",
    mode: "L1",
    query: "",
    surface: "codex",
    session_id: "session-feature-flags",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    ...overrides
  };
}

function createSourceRecord(id: string, createdAt: string): SourceRecord {
  return {
    id,
    source_kind: "vega_memory",
    content: `bootstrap memory ${id}`,
    created_at: createdAt,
    provenance: {
      origin: `memory://${id}`,
      retrieved_at: new Date(NOW).toISOString()
    },
    raw_score: 0.9
  };
}

function createStaticAdapter(kind: SourceAdapter["kind"], records: SourceRecord[] = []): SourceAdapter {
  return {
    kind,
    name: `${kind}-test-adapter`,
    enabled: true,
    search() {
      return [...records];
    }
  };
}

function createBootstrapRegistry(records: SourceRecord[]): SourceRegistry {
  const registry = new SourceRegistry();
  registry.register(createStaticAdapter("vega_memory", records));
  registry.register(createStaticAdapter("wiki"));
  registry.register(createStaticAdapter("fact_claim"));
  registry.register(createStaticAdapter("graph"));
  registry.register(createStaticAdapter("archive"));
  registry.register(createStaticAdapter("host_memory_file"));
  return registry;
}

function countBundleRecords(response: ReturnType<RetrievalOrchestrator["resolve"]>): number {
  return response.bundle.sections.reduce((sum, section) => sum + section.records.length, 0);
}

async function createApiHarness(): Promise<ApiHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-ff-ack-"));
  const homeDir = join(tempDir, "home");
  mkdirSync(join(homeDir, ".codex"), { recursive: true });
  writeFileSync(join(homeDir, ".codex", "AGENTS.md"), "# Host Memory\n\nfeature flag ack test\n", "utf8");

  const repository = new Repository(baseConfig.dbPath);
  const searchEngine = new SearchEngine(repository, baseConfig);
  const memoryService = new MemoryService(repository, baseConfig);
  const recallService = new RecallService(repository, searchEngine, baseConfig);
  const sessionService = new SessionService(repository, memoryService, recallService, baseConfig);
  const compactService = new CompactService(repository, baseConfig);
  const server = createAPIServer(
    {
      repository,
      memoryService,
      recallService,
      sessionService,
      compactService
    },
    baseConfig,
    {
      homeDir
    }
  );
  const port = await server.start(0);
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    repository,
    request(path: string, init?: RequestInit): Promise<Response> {
      const headers = new Headers(init?.headers);
      headers.set("authorization", "Bearer feature-flag-secret");

      if (init?.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      return fetch(`${baseUrl}${path}`, {
        ...init,
        headers
      });
    },
    async cleanup(): Promise<void> {
      await server.stop();
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test("retrieval-queryless-bootstrap default on returns queryless bootstrap records", () => {
  const registryFile = writeFlagRegistry(defaultFlagsYaml);

  try {
    const response = withRegistryPath(registryFile.path, () =>
      new RetrievalOrchestrator({
        registry: createBootstrapRegistry([
          createSourceRecord("mem-1", "2026-04-19T00:00:00.000Z"),
          createSourceRecord("mem-2", "2026-04-20T00:00:00.000Z"),
          createSourceRecord("mem-3", "2026-04-21T00:00:00.000Z")
        ])
      }).resolve(createRequest())
    );

    assert.ok(countBundleRecords(response) > 0);
  } finally {
    registryFile.cleanup();
  }
});

test("retrieval-queryless-bootstrap off returns an empty bundle for queryless bootstrap", () => {
  const registryFile = writeFlagRegistry(bootstrapFlagOffYaml);

  try {
    const response = withRegistryPath(registryFile.path, () =>
      new RetrievalOrchestrator({
        registry: createBootstrapRegistry([
          createSourceRecord("mem-1", "2026-04-19T00:00:00.000Z"),
          createSourceRecord("mem-2", "2026-04-20T00:00:00.000Z"),
          createSourceRecord("mem-3", "2026-04-21T00:00:00.000Z")
        ])
      }).resolve(createRequest())
    );

    assert.equal(countBundleRecords(response), 0);
  } finally {
    registryFile.cleanup();
  }
});

test("usage-ack-echo-source-kind default on includes echoed_source_kinds in HTTP responses", async () => {
  const registryFile = writeFlagRegistry(defaultFlagsYaml);

  try {
    const harness = await withRegistryPath(registryFile.path, () => createApiHarness());

    try {
      const response = await harness.request("/usage_ack", {
        method: "POST",
        body: JSON.stringify({
          checkpoint_id: "checkpoint-default-on",
          bundle_digest: "digest-default-on",
          sufficiency: "sufficient",
          host_tier: "T2",
          evidence: "source_kind echo",
          turn_elapsed_ms: 64,
          bundle_sections: [
            {
              source_kind: "host_memory_file",
              records: [
                {
                  id: "host-record",
                  source_kind: "host_memory_file",
                  content: "host content",
                  provenance: {
                    origin: "/tmp/host-memory.md",
                    retrieved_at: new Date(NOW).toISOString()
                  }
                }
              ]
            },
            {
              source_kind: "wiki",
              records: [
                {
                  id: "wiki-record",
                  source_kind: "wiki",
                  content: "wiki content",
                  provenance: {
                    origin: "wiki://source-kind",
                    retrieved_at: new Date(NOW).toISOString()
                  }
                }
              ]
            }
          ]
        })
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ack: true,
        echoed_source_kinds: ["host_memory_file", "wiki"]
      });
    } finally {
      await harness.cleanup();
    }
  } finally {
    registryFile.cleanup();
  }
});

test("usage-ack-echo-source-kind off omits echoed_source_kinds in HTTP responses", async () => {
  const registryFile = writeFlagRegistry(usageAckFlagOffYaml);

  try {
    const harness = await withRegistryPath(registryFile.path, () => createApiHarness());

    try {
      const response = await harness.request("/usage_ack", {
        method: "POST",
        body: JSON.stringify({
          checkpoint_id: "checkpoint-echo-off",
          bundle_digest: "digest-echo-off",
          sufficiency: "sufficient",
          host_tier: "T2",
          evidence: "source_kind echo",
          turn_elapsed_ms: 64,
          bundle_sections: [
            {
              source_kind: "host_memory_file",
              records: [
                {
                  id: "host-record",
                  source_kind: "host_memory_file",
                  content: "host content",
                  provenance: {
                    origin: "/tmp/host-memory.md",
                    retrieved_at: new Date(NOW).toISOString()
                  }
                }
              ]
            },
            {
              source_kind: "wiki",
              records: [
                {
                  id: "wiki-record",
                  source_kind: "wiki",
                  content: "wiki content",
                  provenance: {
                    origin: "wiki://source-kind",
                    retrieved_at: new Date(NOW).toISOString()
                  }
                }
              ]
            }
          ]
        })
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ack: true });
    } finally {
      await harness.cleanup();
    }
  } finally {
    registryFile.cleanup();
  }
});

test("ranker-recency-halflife-14d default off keeps a seven-day half-life", () => {
  const registryFile = writeFlagRegistry(defaultFlagsYaml);

  try {
    const originalNow = Date.now;
    Date.now = () => NOW;

    try {
      const ranked = withRegistryPath(registryFile.path, () =>
        rank(
          [
            {
              id: "ranked-record",
              source_kind: "vega_memory",
              content: "recency test",
              created_at: new Date(NOW - 7 * DAY_MS).toISOString(),
              provenance: {
                origin: "memory://ranked-record",
                retrieved_at: new Date(NOW).toISOString()
              }
            }
          ],
          createRequest({ intent: "lookup", query: "recency probe" })
        )
      );

      assert.ok(Math.abs((ranked[0]?.score_breakdown.recency ?? 0) - 0.5) < 0.01);
    } finally {
      Date.now = originalNow;
    }
  } finally {
    registryFile.cleanup();
  }
});

test("ranker-recency-halflife-14d on switches the same seven-day-old record to a fourteen-day half-life", () => {
  const registryFile = writeFlagRegistry(rankerFlagOnYaml);

  try {
    const originalNow = Date.now;
    Date.now = () => NOW;

    try {
      const ranked = withRegistryPath(registryFile.path, () =>
        rank(
          [
            {
              id: "ranked-record",
              source_kind: "vega_memory",
              content: "recency test",
              created_at: new Date(NOW - 7 * DAY_MS).toISOString(),
              provenance: {
                origin: "memory://ranked-record",
                retrieved_at: new Date(NOW).toISOString()
              }
            }
          ],
          createRequest({ intent: "lookup", query: "recency probe" })
        )
      );

      assert.ok(Math.abs((ranked[0]?.score_breakdown.recency ?? 0) - 0.707) < 0.02);
    } finally {
      Date.now = originalNow;
    }
  } finally {
    registryFile.cleanup();
  }
});
