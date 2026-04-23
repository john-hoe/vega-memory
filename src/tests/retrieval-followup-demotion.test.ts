import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_KINDS,
  type CheckpointRecord,
  recordKey
} from "../core/contracts/index.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import { SourceRegistry, type SourceAdapter, type SourceRecord } from "../retrieval/index.js";
import type { Intent, SourceKind } from "../core/contracts/enums.js";
import {
  type CheckpointFailureRecord,
  type CheckpointFailureStore,
  createCheckpointStore,
  type CheckpointStore
} from "../usage/index.js";

type PendingCheckpointRecord = Omit<CheckpointRecord, "created_at" | "ttl_expires_at">;

function createRequest(intent: Intent, overrides: Partial<IntentRequest> = {}): IntentRequest {
  const base: IntentRequest = {
    intent,
    mode: "L1",
    query: "followup demotion",
    surface: "codex",
    session_id: "session-followup",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory"
  };

  if (intent === "followup") {
    return {
      ...base,
      prev_checkpoint_id: "prev-checkpoint",
      ...overrides
    };
  }

  return {
    ...base,
    ...overrides
  };
}

function createRecord(
  source_kind: SourceKind,
  id: string,
  raw_score: number,
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

function createRegistry(adapters: SourceAdapter[]): SourceRegistry {
  const registry = new SourceRegistry();

  for (const adapter of adapters) {
    registry.register(adapter);
  }

  return registry;
}

function createFollowupRegistry(records: {
  vega_memory?: SourceRecord[];
  candidate?: SourceRecord[];
  wiki?: SourceRecord[];
}): SourceRegistry {
  return createRegistry([
    createFakeAdapter("vega_memory", records.vega_memory ?? []),
    createFakeAdapter("candidate", records.candidate ?? []),
    createFakeAdapter("wiki", records.wiki ?? [])
  ]);
}

function getSectionRecordIds(
  response: ReturnType<RetrievalOrchestrator["resolve"]>,
  source_kind: SourceKind
): string[] {
  return (
    response.bundle.sections.find((section) => section.source_kind === source_kind)?.records.map((record) => record.id) ??
    []
  );
}

function createFailureStoreHarness(): {
  failures: CheckpointFailureRecord[];
  store: CheckpointFailureStore;
} {
  const failures: CheckpointFailureRecord[] = [];

  return {
    failures,
    store: {
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
    }
  };
}

test("lookup persists a checkpoint whose record_ids use source-prefixed composite keys", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const checkpointStore = createCheckpointStore(db, {
      ttl_ms: 1_800_000,
      now: () => 1_000
    });
    const orchestrator = new RetrievalOrchestrator({
      registry: createRegistry([
        createFakeAdapter("vega_memory", [createRecord("vega_memory", "mem-1", 0.9)]),
        createFakeAdapter("wiki", [createRecord("wiki", "wiki-1", 0.8)]),
        createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1", 0.7)])
      ]),
      checkpoint_store: checkpointStore
    });

    const response = orchestrator.resolve(createRequest("lookup"));
    const stored = checkpointStore.get(response.checkpoint_id);

    assert.ok(stored);
    assert.equal(
      stored?.record_ids.every((value: string) => value.includes(":")),
      true
    );
    assert.equal(
      stored?.record_ids.some((value: string) =>
        SOURCE_KINDS.some((kind) => value.startsWith(`${kind}:`))
      ),
      true
    );
    assert.equal(stored?.record_ids.includes("wiki:wiki-1"), true);
  } finally {
    db.close();
  }
});

test("followup demotes records from the previous checkpoint so fresher wiki records sort first", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const checkpointStore = createCheckpointStore(db, {
      ttl_ms: 1_800_000,
      now: () => now
    });
    const initialOrchestrator = new RetrievalOrchestrator({
      registry: createRegistry([
        createFakeAdapter("vega_memory", [createRecord("vega_memory", "vm-lookup", 0.4)]),
        createFakeAdapter("wiki", [createRecord("wiki", "repeat", 0.9)]),
        createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-lookup", 0.4)])
      ]),
      checkpoint_store: checkpointStore
    });

    const initial = initialOrchestrator.resolve(createRequest("lookup"));
    now = 1_010;

    const followup = new RetrievalOrchestrator({
      registry: createFollowupRegistry({
        wiki: [
          createRecord("wiki", "repeat", 0.9),
          createRecord("wiki", "fresh", 0.5)
        ]
      }),
      checkpoint_store: checkpointStore
    }).resolve(
      createRequest("followup", {
        prev_checkpoint_id: initial.checkpoint_id
      })
    );

    assert.deepEqual(getSectionRecordIds(followup, "wiki"), ["fresh", "repeat"]);
  } finally {
    db.close();
  }
});

test("followup returns an error bundle when the previous checkpoint id is unknown", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const orchestrator = new RetrievalOrchestrator({
      registry: createFollowupRegistry({
        wiki: [createRecord("wiki", "fresh", 0.5)]
      }),
      checkpoint_store: createCheckpointStore(db)
    });

    const response = orchestrator.resolve(
      createRequest("followup", {
        prev_checkpoint_id: "missing-checkpoint"
      })
    );

    assert.equal(response.bundle_digest, "error");
    assert.deepEqual(response.bundle.sections, []);
  } finally {
    db.close();
  }
});

test("followup returns an error bundle when the previous checkpoint has expired", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const checkpointStore = createCheckpointStore(db, {
      ttl_ms: 10,
      now: () => now
    });
    const initial = new RetrievalOrchestrator({
      registry: createRegistry([
        createFakeAdapter("vega_memory", [createRecord("vega_memory", "vm-lookup", 0.4)]),
        createFakeAdapter("wiki", [createRecord("wiki", "repeat", 0.9)]),
        createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-lookup", 0.4)])
      ]),
      checkpoint_store: checkpointStore
    }).resolve(createRequest("lookup"));

    now = 1_011;

    const response = new RetrievalOrchestrator({
      registry: createFollowupRegistry({
        wiki: [createRecord("wiki", "fresh", 0.5)]
      }),
      checkpoint_store: checkpointStore
    }).resolve(
      createRequest("followup", {
        prev_checkpoint_id: initial.checkpoint_id
      })
    );

    assert.equal(response.bundle_digest, "error");
    assert.deepEqual(response.bundle.sections, []);
  } finally {
    db.close();
  }
});

test("followup without a checkpoint store is rejected with an error bundle", () => {
  const orchestrator = new RetrievalOrchestrator({
    registry: createFollowupRegistry({
      wiki: [createRecord("wiki", "fresh", 0.5)]
    })
  });

  const response = orchestrator.resolve(
    createRequest("followup", {
      prev_checkpoint_id: "missing-checkpoint"
    })
  );

  assert.equal(response.bundle_digest, "error");
  assert.deepEqual(response.bundle.sections, []);
});

test("followup without a checkpoint store records a checkpoint failure when the failure store is available", () => {
  const { failures, store: failureStore } = createFailureStoreHarness();
  const orchestrator = new RetrievalOrchestrator({
    registry: createFollowupRegistry({
      wiki: [createRecord("wiki", "fresh", 0.5)]
    }),
    checkpoint_failure_store: failureStore
  });

  const response = orchestrator.resolve(
    createRequest("followup", {
      prev_checkpoint_id: "missing-checkpoint"
    })
  );

  assert.equal(response.bundle_digest, "error");
  assert.deepEqual(response.bundle.sections, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.reason, "followup_requires_checkpoint_store");
});

test("followup cooldown blocks immediate repeated followups on the same lineage", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const checkpointStore = createCheckpointStore(db, {
      ttl_ms: 1_800_000,
      now: () => now
    });

    checkpointStore.put({
      checkpoint_id: "prev-checkpoint",
      bundle_digest: "bundle-prev",
      intent: "followup",
      surface: "codex",
      session_id: "session-followup",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory",
      query_hash: "query-hash-prev",
      mode: "L1",
      profile_used: "followup",
      ranker_version: "v1.0",
      record_ids: [recordKey("wiki", "repeat")],
      prev_checkpoint_id: "root-checkpoint",
      lineage_root_checkpoint_id: "root-checkpoint",
      followup_depth: 1
    });

    const response = new RetrievalOrchestrator({
      registry: createFollowupRegistry({
        wiki: [createRecord("wiki", "fresh", 0.5)]
      }),
      checkpoint_store: checkpointStore,
      followup_guardrails: {
        cooldown_ms: 10_000,
        max_followups: 2
      },
      now: () => now
    }).resolve(
      createRequest("followup", {
        prev_checkpoint_id: "prev-checkpoint"
      })
    );

    assert.equal(response.bundle_digest, "error");
    assert.match(response.warnings.join(","), /followup_cooldown_active/);
    assert.equal(response.next_retrieval_hint, "none");
  } finally {
    db.close();
  }
});

test("followup max_followups upgrades the lineage to needs_external", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const checkpointStore = createCheckpointStore(db, {
      ttl_ms: 1_800_000,
      now: () => 1_000
    });

    checkpointStore.put({
      checkpoint_id: "prev-checkpoint",
      bundle_digest: "bundle-prev",
      intent: "followup",
      surface: "codex",
      session_id: "session-followup",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory",
      query_hash: "query-hash-prev",
      mode: "L1",
      profile_used: "followup",
      ranker_version: "v1.0",
      record_ids: [recordKey("wiki", "repeat")],
      prev_checkpoint_id: "root-checkpoint",
      lineage_root_checkpoint_id: "root-checkpoint",
      followup_depth: 2
    });

    const response = new RetrievalOrchestrator({
      registry: createFollowupRegistry({
        wiki: [createRecord("wiki", "fresh", 0.5)]
      }),
      checkpoint_store: checkpointStore,
      followup_guardrails: {
        cooldown_ms: 0,
        max_followups: 2
      }
    }).resolve(
      createRequest("followup", {
        prev_checkpoint_id: "prev-checkpoint"
      })
    );

    assert.equal(response.bundle_digest, "error");
    assert.match(response.warnings.join(","), /followup_limit_reached/);
    assert.equal(response.next_retrieval_hint, "needs_external");
  } finally {
    db.close();
  }
});

test("error responses do not write checkpoints", () => {
  const puts: PendingCheckpointRecord[] = [];
  const checkpointStore: CheckpointStore = {
    put(record: PendingCheckpointRecord): void {
      puts.push(record);
    },
    get(): CheckpointRecord | undefined {
      return undefined;
    },
    evictExpired(): number {
      return 0;
    },
    size(): number {
      return puts.length;
    }
  };

  const failingRegistry = {
    searchMany() {
      throw new Error("registry exploded");
    }
  } as unknown as SourceRegistry;

  const errorResponse = new RetrievalOrchestrator({
    registry: failingRegistry,
    checkpoint_store: checkpointStore
  }).resolve(createRequest("lookup"));

  assert.equal(errorResponse.bundle_digest, "error");
  assert.equal(puts.length, 0);
});

test("truncated responses write checkpoints to enable followup", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const checkpointStore = createCheckpointStore(db, {
      ttl_ms: 1_800_000,
      now: () => now
    });
    const initial = new RetrievalOrchestrator({
      registry: createRegistry([
        createFakeAdapter("vega_memory", [createRecord("vega_memory", "vm-1", 0.8, "x".repeat(320))]),
        createFakeAdapter("wiki", [createRecord("wiki", "wiki-1", 0.8, "x".repeat(320))]),
        createFakeAdapter("fact_claim", [createRecord("fact_claim", "fact-1", 0.8, "x".repeat(320))])
      ]),
    checkpoint_store: checkpointStore,
    budget_config: {
        max_tokens_by_mode: { L0: 1, L1: 1, L2: 1, L3: 1 },
        host_memory_file_reserved: 0
      }
    }).resolve(createRequest("lookup", { session_id: "session-truncated" }));

    now += 1;
    const followup = new RetrievalOrchestrator({
      registry: createFollowupRegistry({
        wiki: [createRecord("wiki", "fresh", 0.5)]
      }),
      checkpoint_store: checkpointStore
    }).resolve(
      createRequest("followup", {
        session_id: "session-truncated",
        prev_checkpoint_id: initial.checkpoint_id
      })
    );

    assert.equal(initial.sufficiency_hint, "may_need_followup");
    assert.ok(checkpointStore.get(initial.checkpoint_id));
    assert.notEqual(followup.bundle_digest, "error");
    assert.notDeepEqual(followup.bundle.sections, []);
  } finally {
    db.close();
  }
});

test("demotion keys remain isolated across source kinds even when ids collide", () => {
  const db = new SQLiteAdapter(":memory:");
  let now = 1_000;

  try {
    const checkpointStore = createCheckpointStore(db, {
      ttl_ms: 1_800_000,
      now: () => now
    });

    checkpointStore.put({
      checkpoint_id: "prev-checkpoint",
      bundle_digest: "bundle-prev",
      intent: "lookup",
      surface: "codex",
      session_id: "session-followup",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory",
      query_hash: "query-hash-prev",
      mode: "L1",
      profile_used: "lookup",
      ranker_version: "v1.0",
      record_ids: [recordKey("wiki", "abc")]
    });

    const response = new RetrievalOrchestrator({
      registry: createFollowupRegistry({
        vega_memory: [createRecord("vega_memory", "abc", 0.7)],
        wiki: [createRecord("wiki", "abc", 0.9)]
      }),
      checkpoint_store: checkpointStore
    }).resolve(
      createRequest("followup", {
        prev_checkpoint_id: "prev-checkpoint"
      })
    );

    assert.deepEqual(getSectionRecordIds(response, "vega_memory"), ["abc"]);
    assert.deepEqual(getSectionRecordIds(response, "wiki"), ["abc"]);
    const vegaScore = response.bundle.sections
      .find((section) => section.source_kind === "vega_memory")
      ?.records[0]?.score;
    const wikiScore = response.bundle.sections
      .find((section) => section.source_kind === "wiki")
      ?.records[0]?.score;

    assert.ok((vegaScore ?? 0) > (wikiScore ?? 0));
  } finally {
    db.close();
  }
});

for (const mismatchCase of [
  {
    name: "cross-session mismatches are downgraded to prev_checkpoint_not_found",
    overrides: { session_id: "session-other" },
    mismatch_field: "session_id"
  },
  {
    name: "cross-project mismatches are downgraded to prev_checkpoint_not_found",
    overrides: { project: "other-project" },
    mismatch_field: "project"
  },
  {
    name: "cross-cwd mismatches are downgraded to prev_checkpoint_not_found",
    overrides: { cwd: "/tmp/other-project" },
    mismatch_field: "cwd"
  },
  {
    name: "cross-surface mismatches are downgraded to prev_checkpoint_not_found",
    overrides: { surface: "api" as const },
    mismatch_field: "surface"
  }
] as const) {
  test(mismatchCase.name, () => {
    const db = new SQLiteAdapter(":memory:");
    const { failures, store: failureStore } = createFailureStoreHarness();

    try {
      const checkpointStore = createCheckpointStore(db, {
        ttl_ms: 1_800_000,
        now: () => 1_000
      });
      checkpointStore.put({
        checkpoint_id: "prev-checkpoint",
        bundle_digest: "bundle-prev",
        intent: "lookup",
        surface: "codex",
        session_id: "session-followup",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory",
        query_hash: "query-hash-prev",
        mode: "L1",
        profile_used: "lookup",
        ranker_version: "v1.0",
        record_ids: [recordKey("wiki", "repeat")]
      });

      const response = new RetrievalOrchestrator({
        registry: createFollowupRegistry({
          wiki: [createRecord("wiki", "fresh", 0.5)]
        }),
        checkpoint_store: checkpointStore,
        checkpoint_failure_store: failureStore
      }).resolve(
        createRequest("followup", {
          prev_checkpoint_id: "prev-checkpoint",
          ...mismatchCase.overrides
        })
      );

      assert.equal(response.bundle_digest, "error");
      assert.deepEqual(response.bundle.sections, []);
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.reason, "prev_checkpoint_context_mismatch");
      assert.equal(
        JSON.parse(failures[0]?.payload ?? "{}").mismatch_fields.includes(mismatchCase.mismatch_field),
        true
      );
    } finally {
      db.close();
    }
  });
}
