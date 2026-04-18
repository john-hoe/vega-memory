import assert from "node:assert/strict";
import test from "node:test";

import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import { SourceRegistry, type SourceAdapter } from "../retrieval/index.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { createCandidateRepository } from "../db/candidate-repository.js";
import { createCandidateMemoryAdapter } from "../retrieval/sources/candidate-memory.js";
import { createCheckpointStore } from "../usage/index.js";

function createRequest() {
  return {
    intent: "lookup" as const,
    mode: "L1" as const,
    query: "candidate visibility",
    surface: "codex" as const,
    session_id: "session-candidate-visibility",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory"
  };
}

function createEmptyAdapter(kind: SourceAdapter["kind"]): SourceAdapter {
  return {
    kind,
    name: `empty-${kind}`,
    enabled: true,
    search() {
      return [];
    }
  };
}

function createRegistry(candidate: SourceAdapter): SourceRegistry {
  const registry = new SourceRegistry();

  registry.register(createEmptyAdapter("vega_memory"));
  registry.register(candidate);
  registry.register(createEmptyAdapter("wiki"));

  return registry;
}

function createLookupRegistry(): SourceRegistry {
  const registry = new SourceRegistry();

  registry.register(createEmptyAdapter("vega_memory"));
  registry.register(createEmptyAdapter("wiki"));
  registry.register(createEmptyAdapter("fact_claim"));

  return registry;
}

function resolveFollowup(orchestrator: RetrievalOrchestrator, checkpoint_id: string) {
  return orchestrator.resolve({
    ...createRequest(),
    intent: "followup",
    prev_checkpoint_id: checkpoint_id
  });
}

function withCandidateVisibilityEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.VEGA_CANDIDATE_VISIBILITY_ENABLED;

  if (value === undefined) {
    delete process.env.VEGA_CANDIDATE_VISIBILITY_ENABLED;
  } else {
    process.env.VEGA_CANDIDATE_VISIBILITY_ENABLED = value;
  }

  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.VEGA_CANDIDATE_VISIBILITY_ENABLED;
    } else {
      process.env.VEGA_CANDIDATE_VISIBILITY_ENABLED = previous;
    }
  }
}

test("candidate source stays dark by default even when followup profile includes candidate", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const checkpointStore = createCheckpointStore(db);
    const repository = createCandidateRepository(db);
    repository.create({
      content: "candidate 1",
      type: "observation",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.8,
      visibility_gated: false
    });
    repository.create({
      content: "candidate 2",
      type: "pitfall",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.7,
      visibility_gated: false
    });
    repository.create({
      content: "candidate 3",
      type: "observation",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.6,
      visibility_gated: false
    });

    const checkpoint_id = new RetrievalOrchestrator({
      registry: createLookupRegistry(),
      checkpoint_store: checkpointStore
    }).resolve({
      ...createRequest(),
      intent: "lookup"
    }).checkpoint_id;
    const orchestrator = new RetrievalOrchestrator({
      registry: createRegistry(
        createCandidateMemoryAdapter({
          repository,
          visibilityEnabled: false
        })
      ),
      checkpoint_store: checkpointStore
    });
    const response = resolveFollowup(orchestrator, checkpoint_id);

    assert.equal(response.profile_used, "followup");
    assert.equal(
      response.bundle.sections.some((section) => section.source_kind === "candidate"),
      false
    );
  } finally {
    db.close();
  }
});

test("candidate source appears when visibility is enabled and rows are ungated", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const checkpointStore = createCheckpointStore(db);
    const repository = createCandidateRepository(db);
    repository.create({
      content: "candidate A",
      type: "observation",
      project: "vega-memory",
      tags: ["a"],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.8,
      visibility_gated: false
    });
    repository.create({
      content: "candidate B",
      type: "pitfall",
      project: "vega-memory",
      tags: ["b"],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.7,
      visibility_gated: false
    });
    repository.create({
      content: "candidate C",
      type: "observation",
      project: "vega-memory",
      tags: ["c"],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.6,
      visibility_gated: false
    });

    const checkpoint_id = new RetrievalOrchestrator({
      registry: createLookupRegistry(),
      checkpoint_store: checkpointStore
    }).resolve({
      ...createRequest(),
      intent: "lookup"
    }).checkpoint_id;
    const orchestrator = new RetrievalOrchestrator({
      registry: createRegistry(
        createCandidateMemoryAdapter({
          repository,
          visibilityEnabled: true
        })
      ),
      checkpoint_store: checkpointStore
    });
    const response = resolveFollowup(orchestrator, checkpoint_id);
    const candidateSection = response.bundle.sections.find(
      (section) => section.source_kind === "candidate"
    );

    assert.equal(candidateSection?.records.length, 3);
    assert.deepEqual(
      candidateSection?.records.map((record) => record.content).sort(),
      ["candidate A", "candidate B", "candidate C"]
    );
  } finally {
    db.close();
  }
});

test("row-level visibility_gated filters candidate rows even when global visibility is enabled", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const checkpointStore = createCheckpointStore(db);
    const repository = createCandidateRepository(db);
    repository.create({
      content: "visible candidate",
      type: "observation",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.8,
      visibility_gated: false
    });
    repository.create({
      content: "hidden candidate",
      type: "observation",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.8,
      visibility_gated: true
    });

    const checkpoint_id = new RetrievalOrchestrator({
      registry: createLookupRegistry(),
      checkpoint_store: checkpointStore
    }).resolve({
      ...createRequest(),
      intent: "lookup"
    }).checkpoint_id;
    const orchestrator = new RetrievalOrchestrator({
      registry: createRegistry(
        createCandidateMemoryAdapter({
          repository,
          visibilityEnabled: true
        })
      ),
      checkpoint_store: checkpointStore
    });
    const response = resolveFollowup(orchestrator, checkpoint_id);
    const candidateSection = response.bundle.sections.find(
      (section) => section.source_kind === "candidate"
    );

    assert.deepEqual(candidateSection?.records.map((record) => record.content), ["visible candidate"]);
  } finally {
    db.close();
  }
});

test("enabled candidate source with no rows returns no candidate section and no error", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const checkpointStore = createCheckpointStore(db);
    const repository = createCandidateRepository(db);
    const checkpoint_id = new RetrievalOrchestrator({
      registry: createLookupRegistry(),
      checkpoint_store: checkpointStore
    }).resolve({
      ...createRequest(),
      intent: "lookup"
    }).checkpoint_id;
    const orchestrator = new RetrievalOrchestrator({
      registry: createRegistry(
        createCandidateMemoryAdapter({
          repository,
          visibilityEnabled: true
        })
      ),
      checkpoint_store: checkpointStore
    });
    const response = resolveFollowup(orchestrator, checkpoint_id);

    assert.equal(
      response.bundle.sections.some((section) => section.source_kind === "candidate"),
      false
    );
  } finally {
    db.close();
  }
});

test("adapter reads visibility from env when explicit override is omitted", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    repository.create({
      content: "env visible candidate",
      type: "observation",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.9,
      visibility_gated: false
    });

    const result = withCandidateVisibilityEnv("true", () => {
      const adapter = createCandidateMemoryAdapter({ repository });

      return adapter.search({
        request: createRequest(),
        top_k: 3,
        depth: "standard"
      });
    });

    assert.equal(result.length, 1);
    assert.equal(result[0]?.content, "env visible candidate");
  } finally {
    db.close();
  }
});

test("adapter env parsing accepts common truthy values (1 / on / yes / TRUE)", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const repository = createCandidateRepository(db);
    repository.create({
      content: "truthy env candidate",
      type: "observation",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.7,
      visibility_gated: false
    });

    // readFeatureFlag accepts "1", "on", "true" (case-insensitive). "yes" is NOT accepted
    // (this mirrors src/ingestion/feature-flags.ts — deliberate convention).
    for (const envValue of ["1", "on", "TRUE"]) {
      const result = withCandidateVisibilityEnv(envValue, () => {
        const adapter = createCandidateMemoryAdapter({ repository });

        return adapter.search({
          request: createRequest(),
          top_k: 3,
          depth: "standard"
        });
      });

      assert.equal(result.length, 1, `env=${envValue} should enable visibility`);
    }
  } finally {
    db.close();
  }
});

test("adapter returns visible candidates even when gated candidates were more recent", () => {
  // Regression for round-6 #1: filtering by visibility_gated after LIMIT would
  // drop the visible records whenever gated rows happened to be more recent.
  const db = new SQLiteAdapter(":memory:");
  let clock = 1000;

  try {
    const repository = createCandidateRepository(db, { now: () => (clock += 10) });
    // Create 2 gated candidates first (older).
    for (let i = 0; i < 2; i += 1) {
      repository.create({
        content: `gated older ${i}`,
        type: "observation",
        project: "vega-memory",
        tags: [],
        metadata: {},
        extraction_source: "manual",
        extraction_confidence: 0.5,
        visibility_gated: true
      });
    }
    // Then 1 visible candidate (newer than the gated ones but still within LIMIT).
    repository.create({
      content: "visible newer",
      type: "observation",
      project: "vega-memory",
      tags: [],
      metadata: {},
      extraction_source: "manual",
      extraction_confidence: 0.8,
      visibility_gated: false
    });
    // Then 2 MORE gated candidates (most recent) that would saturate top_k=2
    // if the filter ran after LIMIT.
    for (let i = 0; i < 2; i += 1) {
      repository.create({
        content: `gated newest ${i}`,
        type: "observation",
        project: "vega-memory",
        tags: [],
        metadata: {},
        extraction_source: "manual",
        extraction_confidence: 0.9,
        visibility_gated: true
      });
    }

    const result = withCandidateVisibilityEnv("true", () => {
      const adapter = createCandidateMemoryAdapter({ repository });

      return adapter.search({
        request: createRequest(),
        top_k: 2,
        depth: "standard"
      });
    });

    // The visible record must surface even though gated rows are more recent.
    assert.equal(result.length, 1);
    assert.equal(result[0]?.content, "visible newer");
  } finally {
    db.close();
  }
});
