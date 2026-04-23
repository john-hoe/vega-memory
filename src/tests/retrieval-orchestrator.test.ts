import assert from "node:assert/strict";
import test from "node:test";

import type { LogRecord } from "../core/logging/index.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { createPromotionAuditStore } from "../promotion/audit-store.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import { createResolveCache } from "../retrieval/resolve-cache.js";
import { SourceRegistry, type SourceAdapter, type SourceRecord } from "../retrieval/index.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import type { SourceKind } from "../core/contracts/enums.js";
import { createCheckpointStore } from "../usage/checkpoint-store.js";
import type { CheckpointFailureRecord, CheckpointFailureStore } from "../usage/index.js";

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
  assert.equal(response.ranker_version, "v1.1");
  assert.equal(response.bundle.sections.length, 2);
  assert.equal(countBundleRecords(response), 2);
  assert.equal(response.bundle.bundle_digest, response.bundle_digest);
});

test("the same request resolved twice within the TTL reuses the cached bundle but mints a new checkpoint", () => {
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

  assert.notEqual(first.checkpoint_id, second.checkpoint_id);
  assert.equal(first.bundle_digest, second.bundle_digest);
  assert.deepEqual(first.bundle, second.bundle);
  assert.equal(first.profile_used, second.profile_used);
  assert.equal(first.ranker_version, "v1.1");
  assert.equal(first.ranker_version, second.ranker_version);
  assert.equal(cache.size(), 1);
});

test("requests with different project values do not reuse cached checkpoints", () => {
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1")]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1")]),
    createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1")])
  ]);
  const cache = createResolveCache();
  const orchestrator = new RetrievalOrchestrator({
    registry,
    resolve_cache: cache
  });

  const first = orchestrator.resolve(createRequest());
  const second = orchestrator.resolve(
    createRequest({
      project: "vega-memory-alt"
    })
  );

  assert.notEqual(first.checkpoint_id, second.checkpoint_id);
  assert.equal(cache.size(), 2);
});

test("requests with different cwd values do not reuse cached checkpoints", () => {
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1")]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1")]),
    createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1")])
  ]);
  const cache = createResolveCache();
  const orchestrator = new RetrievalOrchestrator({
    registry,
    resolve_cache: cache
  });

  const first = orchestrator.resolve(createRequest());
  const second = orchestrator.resolve(
    createRequest({
      cwd: "/Users/johnmacmini/workspace/vega-memory-alt"
    })
  );

  assert.notEqual(first.checkpoint_id, second.checkpoint_id);
  assert.equal(cache.size(), 2);
});

test("requests with different budget overrides do not reuse cached checkpoints", () => {
  const largeContent = "x".repeat(320);
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1", largeContent)]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1", largeContent)]),
    createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1", largeContent)])
  ]);
  const cache = createResolveCache();
  const orchestrator = new RetrievalOrchestrator({
    registry,
    resolve_cache: cache
  });

  const baseline = orchestrator.resolve(createRequest());
  const constrained = orchestrator.resolve(
    createRequest({
      budget_override: {
        tokens: 1
      }
    })
  );

  assert.notEqual(baseline.checkpoint_id, constrained.checkpoint_id);
  assert.ok(countBundleRecords(baseline) > countBundleRecords(constrained));
  assert.equal(cache.size(), 2);
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

test("followup requests are never cached and reject when checkpoint storage is unavailable", () => {
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

  assert.equal(first.bundle_digest, "error");
  assert.equal(second.bundle_digest, "error");
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

test("failed resolutions are recorded in the checkpoint failure store without changing the error response", () => {
  const registry = {
    searchMany() {
      throw new Error("registry exploded");
    }
  } as unknown as SourceRegistry;
  const failures: CheckpointFailureRecord[] = [];
  const failureStore: CheckpointFailureStore = {
    put(record) {
      const stored = {
        ...record,
        id: `failure-${failures.length + 1}`,
        occurred_at: failures.length + 1
      };
      failures.push(stored);
      return stored;
    },
    listRecent() {
      return [...failures];
    },
    size() {
      return failures.length;
    }
  };
  const orchestrator = new RetrievalOrchestrator({
    registry,
    checkpoint_failure_store: failureStore
  });

  const response = orchestrator.resolve(createRequest());

  assert.equal(response.bundle_digest, "error");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.reason, "resolve_failed");
  assert.equal(failures[0]?.session_id, "session-orchestrator");
});

test("missing followup checkpoints are recorded in the checkpoint failure store", () => {
  const failures: CheckpointFailureRecord[] = [];
  const failureStore: CheckpointFailureStore = {
    put(record) {
      const stored = {
        ...record,
        id: `failure-${failures.length + 1}`,
        occurred_at: failures.length + 1
      };
      failures.push(stored);
      return stored;
    },
    listRecent() {
      return [...failures];
    },
    size() {
      return failures.length;
    }
  };
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1")]),
    createFakeAdapter("candidate", [createRecord("candidate", "cand-1")]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1")])
  ]);
  const checkpointStore = {
    put() {},
    get() {
      return undefined;
    },
    evictExpired() {
      return 0;
    },
    size() {
      return 0;
    }
  };
  const orchestrator = new RetrievalOrchestrator({
    registry,
    checkpoint_store: checkpointStore,
    checkpoint_failure_store: failureStore
  });

  const response = orchestrator.resolve(
    createRequest({
      intent: "followup",
      prev_checkpoint_id: "missing-checkpoint"
    })
  );

  assert.equal(response.bundle_digest, "error");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.reason, "prev_checkpoint_not_found");
  assert.match(failures[0]?.payload ?? "", /missing-checkpoint/u);
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

test("query_focus docs biases lookup toward documentary sources", () => {
  const registry = createRegistry([
    createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1")]),
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-1")]),
    createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1")]),
    createFakeAdapter("host_memory_file", [createRecord("host_memory_file", "host-1")])
  ]);
  const orchestrator = new RetrievalOrchestrator({ registry });

  const response = orchestrator.resolve(
    createRequest({
      query_focus: "docs"
    })
  );

  assert.equal(response.fallback_used, false);
  assert.deepEqual(response.used_sources.sort(), ["fact_claim", "wiki"]);
  assert.match(response.warnings.join(","), /query_focus:docs/);
});

test("empty primary lookup falls back once and marks degraded semantics", () => {
  const registry = new SourceRegistry();

  registry.register(
    createFakeAdapter("vega_memory", [])
  );
  registry.register(
    createFakeAdapter("wiki", [createRecord("wiki", "wiki-fallback")])
  );
  registry.register(
    createFakeAdapter("fact_claim", [])
  );
  registry.register(
    createFakeAdapter("host_memory_file", [])
  );

  const orchestrator = new RetrievalOrchestrator({ registry });
  const response = orchestrator.resolve(
    createRequest({
      query_focus: "history"
    })
  );

  assert.equal(response.fallback_used, true);
  assert.match(response.warnings.join(","), /retrieval_fallback_used/);
  assert.equal(response.next_retrieval_hint, "followup");
  assert.deepEqual(response.used_sources, ["wiki"]);
});

test("promotion feedback boosts candidate ranking during followup when recent hold/demote signals exist", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const checkpointStore = createCheckpointStore(db, { now: () => 1_000 });
    checkpointStore.put({
      checkpoint_id: "prev-checkpoint",
      bundle_digest: "bundle-prev",
      intent: "lookup",
      surface: "codex",
      session_id: "session-orchestrator",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory",
      query_hash: "query-prev",
      mode: "L1",
      profile_used: "lookup",
      ranker_version: "v1.0",
      record_ids: ["wiki:wiki-prev"],
      prev_checkpoint_id: null,
      lineage_root_checkpoint_id: "prev-checkpoint",
      followup_depth: 0
    });
    const auditStore = createPromotionAuditStore(db, {
      now: () => 1_000,
      idFactory: (() => {
        let index = 0;
        return () => `audit-${++index}`;
      })()
    });
    auditStore.put({
      memory_id: "cand-1",
      project: "vega-memory",
      action: "hold",
      trigger: "policy",
      from_state: "pending",
      to_state: "held",
      policy_name: "default",
      policy_version: "v1",
      reason: "hold",
      actor: null
    });
    auditStore.put({
      memory_id: "cand-1",
      project: "vega-memory",
      action: "demote",
      trigger: "manual",
      from_state: "promoted",
      to_state: "held",
      policy_name: "default",
      policy_version: "v1",
      reason: "demote",
      actor: "tester"
    });
    auditStore.put({
      memory_id: "cand-1",
      project: "vega-memory",
      action: "hold",
      trigger: "policy",
      from_state: "held",
      to_state: "held",
      policy_name: "default",
      policy_version: "v1",
      reason: "hold-again",
      actor: null
    });

    const registry = createRegistry([
      createFakeAdapter("vega_memory", []),
      createFakeAdapter("candidate", [createRecord("candidate", "cand-1", "candidate content")]),
      createFakeAdapter("wiki", [createRecord("wiki", "wiki-1", "wiki content")])
    ]);
    const response = new RetrievalOrchestrator({
      registry,
      checkpoint_store: checkpointStore,
      promotion_audit_store: auditStore
    }).resolve(
      createRequest({
        intent: "followup",
        prev_checkpoint_id: "prev-checkpoint",
        query: "feedback"
      })
    );

    const candidateScore = response.bundle.sections.find((section) => section.source_kind === "candidate")?.records[0]?.score ?? 0;
    const wikiScore = response.bundle.sections.find((section) => section.source_kind === "wiki")?.records[0]?.score ?? 0;

    assert.ok(candidateScore > wikiScore);
  } finally {
    db.close();
  }
});

test("promotion feedback disables itself on nested followup lineages", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const checkpointStore = createCheckpointStore(db, { now: () => 1_000 });
    checkpointStore.put({
      checkpoint_id: "prev-checkpoint",
      bundle_digest: "bundle-prev",
      intent: "followup",
      surface: "codex",
      session_id: "session-orchestrator",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory",
      query_hash: "query-prev",
      mode: "L1",
      profile_used: "followup",
      ranker_version: "v1.0",
      record_ids: ["wiki:wiki-prev"],
      prev_checkpoint_id: "root-checkpoint",
      lineage_root_checkpoint_id: "root-checkpoint",
      followup_depth: 1
    });
    const auditStore = createPromotionAuditStore(db, {
      now: () => 1_000,
      idFactory: () => "audit-promote"
    });
    auditStore.put({
      memory_id: "cand-1",
      project: "vega-memory",
      action: "hold",
      trigger: "policy",
      from_state: "pending",
      to_state: "held",
      policy_name: "default",
      policy_version: "v1",
      reason: "hold",
      actor: null
    });

    const registry = createRegistry([
      createFakeAdapter("vega_memory", []),
      createFakeAdapter("candidate", [createRecord("candidate", "cand-1", "candidate content")]),
      createFakeAdapter("wiki", [createRecord("wiki", "wiki-1", "wiki content")])
    ]);
    const response = new RetrievalOrchestrator({
      registry,
      checkpoint_store: checkpointStore,
      promotion_audit_store: auditStore
    }).resolve(
      createRequest({
        intent: "followup",
        prev_checkpoint_id: "prev-checkpoint",
        query: "feedback"
      })
    );

    const candidateScore = response.bundle.sections.find((section) => section.source_kind === "candidate")?.records[0]?.score ?? 0;
    const wikiScore = response.bundle.sections.find((section) => section.source_kind === "wiki")?.records[0]?.score ?? 0;

    assert.ok(candidateScore < wikiScore);
  } finally {
    db.close();
  }
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
