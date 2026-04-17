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
  createCheckpointStore,
  type CheckpointStore
} from "../usage/index.js";

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

test("followup without a checkpoint store degrades to the legacy lookup-like behavior", () => {
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

  assert.notEqual(response.bundle_digest, "error");
  assert.deepEqual(getSectionRecordIds(response, "wiki"), ["fresh"]);
});

test("error and truncated responses do not write checkpoints", () => {
  const puts: CheckpointRecord[] = [];
  const checkpointStore: CheckpointStore = {
    put(record: CheckpointRecord): void {
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

  const truncatedResponse = new RetrievalOrchestrator({
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

  assert.equal(errorResponse.bundle_digest, "error");
  assert.equal(truncatedResponse.sufficiency_hint, "may_need_followup");
  assert.equal(puts.length, 0);
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
      record_ids: [recordKey("wiki", "abc")],
      created_at: now,
      ttl_expires_at: now + 1_800_000
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
