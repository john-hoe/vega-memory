import assert from "node:assert/strict";
import test from "node:test";

import type { IntentRequest } from "../core/contracts/intent.js";
import type { SourceKind, Surface, Sufficiency } from "../core/contracts/enums.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { MetricsCollector } from "../monitoring/metrics.js";
import { createVegaMetrics } from "../monitoring/vega-metrics.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import { createCircuitBreaker } from "../retrieval/circuit-breaker.js";
import { SourceRegistry, type SourceAdapter, type SourceRecord } from "../retrieval/index.js";
import { createAckStore } from "../usage/ack-store.js";
import { createCheckpointStore } from "../usage/checkpoint-store.js";
import { createUsageAckMcpTool } from "../usage/usage-ack-handler.js";

function createRequest(overrides: Partial<IntentRequest> = {}): IntentRequest {
  return {
    intent: "lookup",
    mode: "L1",
    query: "vega",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    ...overrides
  };
}

function createRecord(source_kind: SourceKind, id: string, content: string): SourceRecord {
  return {
    id,
    source_kind,
    content,
    provenance: {
      origin: `${source_kind}:${id}`,
      retrieved_at: "2026-04-19T00:00:00.000Z"
    },
    raw_score: 0.9
  };
}

function createRegistry(
  records: Partial<Record<SourceKind, SourceRecord[]>>,
  options: {
    throws?: boolean;
  } = {}
): SourceRegistry {
  const registry = new SourceRegistry();

  for (const kind of ["vega_memory", "wiki", "fact_claim"] as const) {
    const adapter: SourceAdapter = {
      kind,
      name: `${kind}-test`,
      enabled: true,
      search() {
        if (options.throws && kind === "vega_memory") {
          throw new Error("search failed");
        }

        return records[kind] ?? [];
      }
    };

    registry.register(adapter);
  }

  return registry;
}

function seedCheckpoint(
  store: ReturnType<typeof createCheckpointStore>,
  checkpoint_id: string,
  session_id: string,
  surface: Surface = "codex"
): void {
  store.put({
    checkpoint_id,
    bundle_digest: `bundle-${checkpoint_id}`,
    intent: "lookup",
    surface,
    session_id,
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    query_hash: `query-${checkpoint_id}`,
    mode: "L1",
    profile_used: "lookup",
    ranker_version: "v1.0",
    record_ids: [`wiki:${checkpoint_id}`]
  });
}

test("retrieval metrics count all resolve attempts and only count nonempty non-error bundles", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    const metrics = createVegaMetrics(collector, db);

    new RetrievalOrchestrator({
      registry: createRegistry({
        vega_memory: [createRecord("vega_memory", "mem-1", "alpha")]
      }),
      metrics
    }).resolve(createRequest());

    new RetrievalOrchestrator({
      registry: createRegistry({}),
      metrics
    }).resolve(createRequest({ query: "empty-query", session_id: "session-2" }));

    new RetrievalOrchestrator({
      registry: createRegistry({}, { throws: true }),
      metrics
    }).resolve(createRequest({ query: "error-query", session_id: "session-3" }));

    const rendered = await collector.getMetrics();

    assert.match(rendered, /vega_retrieval_calls_total\{surface="codex",intent="lookup"\} 3/);
    assert.match(rendered, /vega_retrieval_nonempty_total\{surface="codex",intent="lookup"\} 1/);
  } finally {
    db.close();
  }
});

test("retrieval observability gauges expose efficiency, source utilization, and bundle coverage", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    const metrics = createVegaMetrics(collector, db);

    new RetrievalOrchestrator({
      registry: createRegistry({
        vega_memory: [createRecord("vega_memory", "mem-1", "alpha")],
        wiki: [createRecord("wiki", "wiki-1", "beta")],
        fact_claim: [createRecord("fact_claim", "fact-1", "gamma")]
      }),
      metrics
    }).resolve(createRequest());

    const rendered = await collector.getMetrics();

    assert.match(
      rendered,
      /vega_retrieval_token_efficiency_ratio\{surface="codex",intent="lookup"\} 1/
    );
    assert.match(
      rendered,
      /vega_retrieval_source_utilization_ratio\{surface="codex",intent="lookup"\} 0.75/
    );
    assert.match(
      rendered,
      /vega_retrieval_bundle_coverage_ratio\{surface="codex",intent="lookup"\} 1/
    );
  } finally {
    db.close();
  }
});

test("usage ack metrics record inserted acknowledgements and loop override emissions, but skip emits without checkpoint surface context", async () => {
  const db = new SQLiteAdapter(":memory:");
  const orphanedDb = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    const metrics = createVegaMetrics(collector, db);
    const ackStore = createAckStore(db, { now: () => now });
    const checkpointStore = createCheckpointStore(db, { now: () => now });
    seedCheckpoint(checkpointStore, "checkpoint-1", "session-loop");
    seedCheckpoint(checkpointStore, "checkpoint-2", "session-loop");

    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => now, undefined, metrics);

    await tool.invoke({
      checkpoint_id: "checkpoint-1",
      bundle_digest: "bundle-checkpoint-1",
      sufficiency: "needs_followup",
      host_tier: "T2"
    });

    now += 1;

    await tool.invoke({
      checkpoint_id: "checkpoint-2",
      bundle_digest: "bundle-checkpoint-2",
      sufficiency: "needs_followup",
      host_tier: "T2"
    });

    const withoutCheckpointSurface = createUsageAckMcpTool(
      createAckStore(orphanedDb),
      undefined,
      () => now,
      undefined,
      metrics
    );

    await withoutCheckpointSurface.invoke({
      checkpoint_id: "orphaned-checkpoint",
      bundle_digest: "bundle-orphaned-checkpoint",
      sufficiency: "needs_followup",
      host_tier: "T2"
    });

    const rendered = await collector.getMetrics();

    assert.match(
      rendered,
      /vega_usage_ack_total\{surface="codex",sufficiency="needs_followup",host_tier="T2"\} 2/
    );
    assert.match(rendered, /vega_usage_followup_loop_override_total\{surface="codex"\} 1/);
    assert.equal(rendered.includes('checkpoint_id="orphaned-checkpoint"'), false);
    assert.equal(
      rendered.includes('vega_usage_ack_total{surface="unknown",sufficiency="needs_followup",host_tier="T2"}'),
      false
    );
  } finally {
    orphanedDb.close();
    db.close();
  }
});

test("usage ack observability signals record missing-trigger and skipped-bundle proxies", async () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    const metrics = createVegaMetrics(collector, db);
    const ackStore = createAckStore(db, { now: () => now });
    const checkpointStore = createCheckpointStore(db, { now: () => now });
    seedCheckpoint(checkpointStore, "checkpoint-1", "session-observe");

    await createUsageAckMcpTool(ackStore, checkpointStore, () => now, undefined, metrics).invoke({
      checkpoint_id: "orphaned-checkpoint",
      bundle_digest: "bundle-orphaned-checkpoint",
      sufficiency: "needs_followup",
      host_tier: "T2"
    });

    await createUsageAckMcpTool(ackStore, checkpointStore, () => now, undefined, metrics).invoke({
      checkpoint_id: "checkpoint-1",
      bundle_digest: "bundle-mismatch",
      sufficiency: "sufficient",
      host_tier: "T2"
    });

    const rendered = await collector.getMetrics();

    assert.match(rendered, /vega_retrieval_missing_trigger_total\{surface="unknown"\} 1/);
    assert.match(rendered, /vega_retrieval_skipped_bundle_total\{surface="codex"\} 1/);
  } finally {
    db.close();
  }
});

test("repeated followup inflation metric increments on an existing followup lineage", async () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    const metrics = createVegaMetrics(collector, db);
    const checkpointStore = createCheckpointStore(db, { now: () => now });

    checkpointStore.put({
      checkpoint_id: "prev-followup",
      bundle_digest: "bundle-prev-followup",
      intent: "followup",
      surface: "codex",
      session_id: "session-followup-metric",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory",
      query_hash: "query-prev-followup",
      mode: "L1",
      profile_used: "followup",
      ranker_version: "v1.0",
      record_ids: ["wiki:repeat"],
      prev_checkpoint_id: "root-followup",
      lineage_root_checkpoint_id: "root-followup",
      followup_depth: 1
    });

    const registry = new SourceRegistry();
    registry.register({
      kind: "vega_memory",
      name: "vega-memory",
      enabled: true,
      search() {
        return [];
      }
    });
    registry.register({
      kind: "candidate",
      name: "candidate",
      enabled: true,
      search() {
        return [];
      }
    });
    registry.register({
      kind: "wiki",
      name: "wiki",
      enabled: true,
      search() {
        return [createRecord("wiki", "fresh", "followup metric")];
      }
    });

    new RetrievalOrchestrator({
      registry,
      checkpoint_store: checkpointStore,
      metrics,
      followup_guardrails: {
        cooldown_ms: 0,
        max_followups: 3
      },
      now: () => now
    }).resolve({
      intent: "followup",
      mode: "L1",
      query: "followup metric",
      surface: "codex",
      session_id: "session-followup-metric",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory",
      prev_checkpoint_id: "prev-followup"
    });

    const rendered = await collector.getMetrics();

    assert.match(rendered, /vega_retrieval_followup_inflation_total\{surface="codex"\} 1/);
  } finally {
    db.close();
  }
});

test("circuit breaker metrics expose per-process state gauges and trip counters", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const collector = new MetricsCollector({
      enabled: true,
      prefix: "vega"
    });
    const metrics = createVegaMetrics(collector, db);
    const breaker = createCircuitBreaker({
      min_checkpoint_count: 1,
      min_ack_count: 1,
      min_ack_rate: 0,
      max_followup_rate: 0,
      metrics
    });

    assert.equal(breaker.getStatus("codex").state, "closed");
    breaker.recordCheckpoint("codex");
    breaker.recordAck("codex", "needs_followup");
    assert.equal(breaker.getStatus("codex").state, "open");

    const rendered = await collector.getMetrics();

    assert.match(rendered, /vega_circuit_breaker_state\{surface="codex"\} 1/);
    assert.match(rendered, /vega_circuit_breaker_trips_total\{surface="codex",reason="high_followup_rate"\} 1/);
    assert.match(
      rendered,
      /# HELP vega_circuit_breaker_state .*per-process, resets on restart/
    );
  } finally {
    db.close();
  }
});
