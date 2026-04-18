import assert from "node:assert/strict";
import test from "node:test";

import type { IntentRequest } from "../core/contracts/intent.js";
import type { SourceKind } from "../core/contracts/enums.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import { createResolveCache } from "../retrieval/resolve-cache.js";
import { SourceRegistry, type SourceAdapter, type SourceRecord } from "../retrieval/index.js";
import {
  createAckStore,
  createCheckpointStore
} from "../usage/index.js";
import { createUsageAckMcpTool } from "../usage/usage-ack-handler.js";

function createRequest(overrides: Partial<IntentRequest> = {}): IntentRequest {
  return {
    intent: "lookup",
    mode: "L1",
    query: "cache checkpoint",
    surface: "codex",
    session_id: "session-cache",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    ...overrides
  };
}

function createRecord(source_kind: SourceKind, id: string, raw_score: number): SourceRecord {
  return {
    id,
    source_kind,
    content: `${source_kind}:${id} content`,
    provenance: {
      origin: `${source_kind}:${id}`,
      retrieved_at: "2026-04-18T00:00:00.000Z"
    },
    raw_score
  };
}

function createFakeAdapter(kind: SourceKind, records: SourceRecord[]): SourceAdapter {
  return {
    kind,
    name: `fake-${kind}`,
    enabled: true,
    search() {
      return records;
    }
  };
}

function createRegistry(): SourceRegistry {
  const registry = new SourceRegistry();

  registry.register(createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1", 0.9)]));
  registry.register(createFakeAdapter("wiki", [createRecord("wiki", "wiki-1", 0.8)]));
  registry.register(createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1", 0.7)]));

  return registry;
}

test("cache hits mint a new checkpoint record while preserving the cached bundle payload", async () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const checkpointStore = createCheckpointStore(db, {
      ttl_ms: 1_800_000,
      now: () => now
    });
    const ackStore = createAckStore(db, { now: () => now });
    const cache = createResolveCache({
      ttl_ms: 60_000,
      now: () => now
    });
    const orchestrator = new RetrievalOrchestrator({
      registry: createRegistry(),
      checkpoint_store: checkpointStore,
      resolve_cache: cache
    });
    const request = createRequest();

    const first = orchestrator.resolve(request);
    now += 1;
    const second = orchestrator.resolve(request);

    assert.notEqual(first.checkpoint_id, second.checkpoint_id);
    assert.deepEqual(first.bundle, second.bundle);
    assert.equal(first.bundle_digest, second.bundle_digest);
    assert.equal(first.profile_used, second.profile_used);
    assert.equal(first.ranker_version, second.ranker_version);

    const firstCheckpoint = checkpointStore.get(first.checkpoint_id);
    const secondCheckpoint = checkpointStore.get(second.checkpoint_id);

    assert.ok(firstCheckpoint);
    assert.ok(secondCheckpoint);
    assert.equal(checkpointStore.size(), 2);
    assert.deepEqual(firstCheckpoint?.record_ids, secondCheckpoint?.record_ids);

    const tool = createUsageAckMcpTool(ackStore, checkpointStore, () => now);
    const firstAck = await tool.invoke({
      checkpoint_id: first.checkpoint_id,
      bundle_digest: first.bundle_digest,
      sufficiency: "needs_followup",
      host_tier: "T2",
      evidence: "needs more",
      turn_elapsed_ms: 125
    });
    now += 1;
    const secondAck = await tool.invoke({
      checkpoint_id: second.checkpoint_id,
      bundle_digest: second.bundle_digest,
      sufficiency: "needs_followup",
      host_tier: "T2",
      evidence: "still needs more",
      turn_elapsed_ms: 126
    });

    assert.deepEqual(firstAck, {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    });
    assert.deepEqual(secondAck, {
      ack: true,
      degraded: "needs_followup_loop_limit",
      forced_sufficiency: "needs_external"
    });
    assert.equal(ackStore.get(second.checkpoint_id)?.sufficiency, "needs_external");
    assert.equal(ackStore.get(second.checkpoint_id)?.guard_overridden, true);
  } finally {
    db.close();
  }
});
