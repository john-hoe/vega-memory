import assert from "node:assert/strict";
import test from "node:test";

import type { LogRecord } from "../core/logging/index.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import { createResolveCache } from "../retrieval/resolve-cache.js";
import { SourceRegistry, type SourceAdapter, type SourceRecord } from "../retrieval/index.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import type { SourceKind } from "../core/contracts/enums.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function createRequest(overrides: Partial<IntentRequest> = {}): IntentRequest {
  return {
    intent: "lookup",
    mode: "L1",
    query: "vega",
    surface: "codex",
    session_id: "session-orchestrator",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    ...overrides
  };
}

function createRecord(
  source_kind: SourceKind,
  id: string,
  content = `${source_kind}:${id} content`
): SourceRecord {
  return {
    id,
    source_kind,
    content,
    provenance: {
      origin: `${source_kind}:${id}`,
      retrieved_at: "2026-04-17T00:00:00.000Z"
    },
    raw_score: 0.8
  };
}

function createFakeAdapter(
  kind: SourceKind,
  records: SourceRecord[],
  options: {
    enabled?: boolean;
    throws?: boolean;
  } = {}
): SourceAdapter {
  return {
    kind,
    name: `fake-${kind}`,
    enabled: options.enabled ?? true,
    search() {
      if (options.throws) {
        throw new Error(`adapter failed: ${kind}`);
      }

      return records;
    }
  };
}

function createRegistry(adapters: SourceAdapter[]): SourceRegistry {
  const registry = new SourceRegistry();

  for (const adapter of adapters) {
    registry.register(adapter);
  }

  return registry;
}

function countBundleRecords(response: ReturnType<RetrievalOrchestrator["resolve"]>): number {
  return response.bundle.sections.reduce((sum, section) => sum + section.records.length, 0);
}

function captureStructuredLogs<T>(run: () => T): { result: T; logs: LogRecord[] } {
  const originalConsoleLog = console.log;
  const logs: LogRecord[] = [];

  console.log = ((...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      try {
        logs.push(JSON.parse(args[0]) as LogRecord);
      } catch {
        return;
      }
    }
  }) as typeof console.log;

  try {
    return {
      result: run(),
      logs
    };
  } finally {
    console.log = originalConsoleLog;
  }
}

test("happy path assembles a bundle and returns a fresh UUID checkpoint", () => {
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1")]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1")]),
    createFakeAdapter("fact_claim", [])
  ]);
  const orchestrator = new RetrievalOrchestrator({ registry });

  const response = orchestrator.resolve(createRequest());

  assert.match(response.checkpoint_id, UUID_V4_PATTERN);
  assert.equal(response.profile_used, "lookup");
  assert.equal(response.ranker_version, "v1.0");
  assert.equal(response.bundle.sections.length, 2);
  assert.equal(countBundleRecords(response), 2);
  assert.equal(response.bundle.bundle_digest, response.bundle_digest);
});

test("the same request resolved twice within the TTL reuses the cached checkpoint", () => {
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1")]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1")]),
    createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1")])
  ]);
  let now = 0;
  const cache = createResolveCache({
    ttl_ms: 60_000,
    now: () => now
  });
  const orchestrator = new RetrievalOrchestrator({
    registry,
    resolve_cache: cache
  });
  const request = createRequest();

  const first = orchestrator.resolve(request);
  now = 59_999;
  const second = orchestrator.resolve(request);

  assert.equal(first.checkpoint_id, second.checkpoint_id);
  assert.equal(first.bundle_digest, second.bundle_digest);
  assert.equal(cache.size(), 1);
});

test("the same request resolved after the TTL expires receives a new checkpoint", () => {
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1")]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1")]),
    createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1")])
  ]);
  let now = 0;
  const orchestrator = new RetrievalOrchestrator({
    registry,
    resolve_cache: createResolveCache({
      ttl_ms: 60_000,
      now: () => now
    })
  });
  const request = createRequest();

  const first = orchestrator.resolve(request);
  now = 60_001;
  const second = orchestrator.resolve(request);

  assert.notEqual(first.checkpoint_id, second.checkpoint_id);
});

test("followup requests are never cached", () => {
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1")]),
    createFakeAdapter("candidate", [createRecord("candidate", "cand-1")]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1")]),
    createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1")])
  ]);
  const cache = createResolveCache();
  const orchestrator = new RetrievalOrchestrator({
    registry,
    resolve_cache: cache
  });
  const request = createRequest({
    intent: "followup",
    prev_checkpoint_id: "checkpoint-previous"
  });

  const first = orchestrator.resolve(request);
  const second = orchestrator.resolve(request);

  assert.notEqual(first.bundle_digest, "error");
  assert.notEqual(first.checkpoint_id, second.checkpoint_id);
  assert.equal(cache.size(), 0);
});

test("fatal registry failures degrade to an error bundle and emit an error log", () => {
  const registry = {
    searchMany() {
      throw new Error("registry exploded");
    }
  } as unknown as SourceRegistry;
  const orchestrator = new RetrievalOrchestrator({ registry });

  const { result, logs } = captureStructuredLogs(() => orchestrator.resolve(createRequest()));

  assert.equal(result.bundle_digest, "error");
  assert.equal(result.bundle.bundle_digest, "error");
  assert.deepEqual(result.bundle.sections, []);
  assert.equal(result.sufficiency_hint, "may_need_followup");
  assert.match(result.checkpoint_id, UUID_V4_PATTERN);

  const errorLog = logs.find((record) => record.level === "error");
  assert.ok(errorLog);
  assert.equal(typeof errorLog?.trace_id, "string");
  assert.match(errorLog?.message ?? "", /Retrieval orchestration failed/u);
});

test("error bundles are never cached", () => {
  const registry = {
    searchMany() {
      throw new Error("registry exploded");
    }
  } as unknown as SourceRegistry;
  const cache = createResolveCache();
  const orchestrator = new RetrievalOrchestrator({
    registry,
    resolve_cache: cache
  });

  const first = orchestrator.resolve(createRequest());
  const second = orchestrator.resolve(createRequest());

  assert.equal(first.bundle_digest, "error");
  assert.equal(second.bundle_digest, "error");
  assert.notEqual(first.checkpoint_id, second.checkpoint_id);
  assert.equal(cache.size(), 0);
});

test("bootstrap profile searches more sources than lookup", () => {
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1")]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1")]),
    createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1")]),
    createFakeAdapter("graph", [createRecord("graph", "graph-1")]),
    createFakeAdapter("host_memory_file", [createRecord("host_memory_file", "host-1")]),
    createFakeAdapter("archive", [createRecord("archive", "archive-1")])
  ]);
  const orchestrator = new RetrievalOrchestrator({ registry });

  const lookupResponse = orchestrator.resolve(createRequest({ intent: "lookup" }));
  const bootstrapResponse = orchestrator.resolve(createRequest({ intent: "bootstrap" }));

  assert.equal(lookupResponse.bundle.sections.length, 3);
  assert.equal(bootstrapResponse.bundle.sections.length, 5);
});

test("budget_override tokens shrink the final bundle", () => {
  const largeContent = "x".repeat(320);
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1", largeContent)]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1", largeContent)]),
    createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1", largeContent)])
  ]);
  const orchestrator = new RetrievalOrchestrator({ registry });

  const baseline = orchestrator.resolve(createRequest());
  const constrained = orchestrator.resolve(
    createRequest({
      session_id: "session-orchestrator-constrained",
      budget_override: {
        tokens: 1
      }
    })
  );

  assert.ok(countBundleRecords(baseline) > countBundleRecords(constrained));
  assert.equal(countBundleRecords(constrained), 0);
});

test("truncation forces a may_need_followup sufficiency hint", () => {
  const largeContent = "y".repeat(240);
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1", largeContent)]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1", largeContent)]),
    createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1", largeContent)])
  ]);
  const orchestrator = new RetrievalOrchestrator({
    registry,
    budget_config: {
      max_tokens_by_mode: {
        L0: 1,
        L1: 1,
        L2: 1,
        L3: 1
      },
      host_memory_file_reserved: 0
    }
  });

  const response = orchestrator.resolve(createRequest());

  assert.equal(response.sufficiency_hint, "may_need_followup");
  assert.equal(countBundleRecords(response), 0);
});
