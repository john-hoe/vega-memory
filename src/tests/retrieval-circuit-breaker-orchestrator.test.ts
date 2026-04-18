import assert from "node:assert/strict";
import test from "node:test";

import type { Bundle } from "../core/contracts/bundle.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import type { SourceKind } from "../core/contracts/enums.js";
import type { CircuitBreaker, SurfaceBreakerStatus } from "../retrieval/circuit-breaker.js";
import { RetrievalOrchestrator, type ContextResolveResponse } from "../retrieval/orchestrator.js";
import { SourceRegistry, type SourceAdapter, type SourceRecord } from "../retrieval/index.js";
import type { CheckpointStore } from "../usage/checkpoint-store.js";

function createRequest(overrides: Partial<IntentRequest> = {}): IntentRequest {
  return {
    intent: "lookup",
    mode: "L1",
    query: "vega",
    surface: "codex",
    session_id: "session-cb",
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

function createBreakerStatus(
  overrides: Partial<SurfaceBreakerStatus> = {}
): SurfaceBreakerStatus {
  return {
    surface: "codex",
    state: "closed",
    tripped_at: null,
    reasons: [],
    consecutive_healthy_samples: 0,
    window_checkpoint_count: 0,
    window_ack_count: 0,
    window_sufficient_ack_count: 0,
    window_needs_followup_ack_count: 0,
    ...overrides
  };
}

function createMockBreaker(status: SurfaceBreakerStatus): {
  breaker: CircuitBreaker;
  calls: {
    getStatus: string[];
    recordCheckpoint: string[];
  };
} {
  const calls = {
    getStatus: [] as string[],
    recordCheckpoint: [] as string[]
  };

  return {
    calls,
    breaker: {
      budget_reduction_factor: 0.5,
      recordCheckpoint(surface) {
        calls.recordCheckpoint.push(surface);
      },
      recordAck() {},
      getStatus(surface) {
        calls.getStatus.push(surface);
        return {
          ...status,
          surface
        };
      },
      listAllStatuses() {
        return [status];
      },
      reset() {}
    }
  };
}

function createMockCheckpointStore(options: {
  failPut?: boolean;
} = {}): {
  store: CheckpointStore;
  calls: {
    put: string[];
  };
} {
  const calls = {
    put: [] as string[]
  };

  return {
    calls,
    store: {
      put(record) {
        calls.put.push(record.checkpoint_id);
        if (options.failPut) {
          throw new Error("disk full");
        }
      },
      get() {
        return undefined;
      },
      evictExpired() {
        return 0;
      },
      size() {
        return calls.put.length;
      }
    }
  };
}

function countBundleRecords(bundle: Bundle): number {
  return bundle.sections.reduce((sum, section) => sum + section.records.length, 0);
}

test("orchestrator without breaker omits circuit_breaker signal", () => {
  const orchestrator = new RetrievalOrchestrator({
    registry: createRegistry({
      vega_memory: [createRecord("vega_memory", "mem-1", "alpha")]
    })
  });

  const response = orchestrator.resolve(createRequest());

  assert.equal(response.circuit_breaker, undefined);
});

test("orchestrator without breaker stays a no-op across repeated successful resolves", () => {
  const orchestrator = new RetrievalOrchestrator({
    registry: createRegistry({
      vega_memory: [createRecord("vega_memory", "mem-1", "alpha")]
    })
  });

  for (let index = 0; index < 50; index += 1) {
    const response = orchestrator.resolve(
      createRequest({
        query: `vega-${index}`,
        session_id: `session-${index}`
      })
    );

    assert.equal(response.circuit_breaker, undefined);
  }
});

test("orchestrator with closed breaker omits circuit_breaker signal when checkpoint storage is unavailable", () => {
  const mock = createMockBreaker(createBreakerStatus());
  const orchestrator = new RetrievalOrchestrator({
    registry: createRegistry({
      vega_memory: [createRecord("vega_memory", "mem-1", "alpha")]
    }),
    circuit_breaker: mock.breaker
  });

  const response = orchestrator.resolve(createRequest());

  assert.equal(response.circuit_breaker, undefined);
  assert.deepEqual(mock.calls.recordCheckpoint, []);
});

test("orchestrator with open breaker includes circuit_breaker signal", () => {
  const mock = createMockBreaker(
    createBreakerStatus({
      state: "open",
      tripped_at: 1_234,
      reasons: ["low_ack_rate", "high_followup_rate"]
    })
  );
  const orchestrator = new RetrievalOrchestrator({
    registry: createRegistry({
      vega_memory: [createRecord("vega_memory", "mem-1", "alpha")]
    }),
    circuit_breaker: mock.breaker
  });

  const response = orchestrator.resolve(createRequest());

  assert.deepEqual(response.circuit_breaker, {
    open: true,
    tripped_at: 1_234,
    reasons: ["low_ack_rate", "high_followup_rate"]
  });
});

test("open breaker applies budget reduction before bundling", () => {
  const content = "x".repeat(20);
  const records = [
    createRecord("vega_memory", "mem-1", content),
    createRecord("vega_memory", "mem-2", content),
    createRecord("vega_memory", "mem-3", content)
  ];
  const registry = createRegistry({
    vega_memory: records
  });
  const baseline = new RetrievalOrchestrator({ registry });
  const reduced = new RetrievalOrchestrator({
    registry,
    circuit_breaker: createMockBreaker(
      createBreakerStatus({
        state: "open",
        tripped_at: 1_234,
        reasons: ["low_ack_rate"]
      })
    ).breaker
  });

  const baselineResponse = baseline.resolve(
    createRequest({
      budget_override: {
        tokens: 12
      }
    })
  );
  const reducedResponse = reduced.resolve(
    createRequest({
      budget_override: {
        tokens: 12
      }
    })
  );

  assert.ok(countBundleRecords(baselineResponse.bundle) > countBundleRecords(reducedResponse.bundle));
});

test("budget reduction still returns a non-error bundle", () => {
  const orchestrator = new RetrievalOrchestrator({
    registry: createRegistry({
      vega_memory: [createRecord("vega_memory", "mem-1", "x".repeat(100))]
    }),
    circuit_breaker: createMockBreaker(
      createBreakerStatus({
        state: "open",
        tripped_at: 1_234,
        reasons: ["low_ack_rate"]
      })
    ).breaker
  });

  const response = orchestrator.resolve(
    createRequest({
      budget_override: {
        tokens: 5
      }
    })
  );

  assert.notEqual(response.bundle_digest, "error");
});

test("successful resolve records a checkpoint sample once", () => {
  const mock = createMockBreaker(createBreakerStatus());
  const checkpointStore = createMockCheckpointStore();
  const orchestrator = new RetrievalOrchestrator({
    registry: createRegistry({
      vega_memory: [createRecord("vega_memory", "mem-1", "alpha")]
    }),
    checkpoint_store: checkpointStore.store,
    circuit_breaker: mock.breaker
  });

  orchestrator.resolve(createRequest());

  assert.equal(checkpointStore.calls.put.length, 1);
  assert.deepEqual(mock.calls.recordCheckpoint, ["codex"]);
});

test("checkpoint persistence failure does not record breaker samples on resolve or cache hit", () => {
  const breaker = createMockBreaker(createBreakerStatus());
  const checkpointStore = createMockCheckpointStore({ failPut: true });
  const orchestrator = new RetrievalOrchestrator({
    registry: createRegistry({
      vega_memory: [createRecord("vega_memory", "mem-1", "alpha")]
    }),
    checkpoint_store: checkpointStore.store,
    circuit_breaker: breaker.breaker
  });
  const request = createRequest();

  orchestrator.resolve(request);
  orchestrator.resolve(request);

  assert.equal(checkpointStore.calls.put.length, 2);
  assert.deepEqual(breaker.calls.recordCheckpoint, []);
});

test("successful checkpoint persistence records breaker samples on resolve and cache hit", () => {
  const breaker = createMockBreaker(createBreakerStatus());
  const checkpointStore = createMockCheckpointStore();
  const orchestrator = new RetrievalOrchestrator({
    registry: createRegistry({
      vega_memory: [createRecord("vega_memory", "mem-1", "alpha")]
    }),
    checkpoint_store: checkpointStore.store,
    circuit_breaker: breaker.breaker
  });
  const request = createRequest();

  orchestrator.resolve(request);
  orchestrator.resolve(request);

  assert.equal(checkpointStore.calls.put.length, 2);
  assert.deepEqual(breaker.calls.recordCheckpoint, ["codex", "codex"]);
});

test("error responses do not record checkpoint samples", () => {
  const mock = createMockBreaker(createBreakerStatus());
  const registry = new SourceRegistry();
  registry.register({
    kind: "vega_memory",
    name: "vega-memory-test",
    enabled: true,
    search() {
      return [];
    }
  });
  const orchestrator = new RetrievalOrchestrator({
    registry,
    circuit_breaker: mock.breaker
  });

  const response = orchestrator.resolve(createRequest());

  assert.equal(response.bundle_digest, "error");
  assert.deepEqual(mock.calls.recordCheckpoint, []);
});

test("ContextResolveResponse type admits circuit_breaker as optional", () => {
  const response: ContextResolveResponse = {
    checkpoint_id: "checkpoint-1",
    bundle_digest: "bundle-1",
    bundle: {
      schema_version: "1.0",
      bundle_digest: "bundle-1",
      sections: []
    },
    profile_used: "lookup",
    ranker_version: "v1.0",
    circuit_breaker: {
      open: true,
      tripped_at: 1,
      reasons: ["low_ack_rate"]
    }
  };

  assert.equal(response.circuit_breaker?.open, true);
});
