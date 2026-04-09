import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import type Database from "better-sqlite3-multiple-ciphers";

import type { VegaConfig } from "../config.js";
import { ArchiveService } from "../core/archive-service.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type { FactClaim, Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { embeddingCache } from "../embedding/cache.js";
import { SearchEngine } from "../search/engine.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  dbEncryption: false
};

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => {
  const { summary = null, ...rest } = overrides;

  return {
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
    ...rest,
    summary
  };
};

const createFactClaim = (overrides: Partial<FactClaim> = {}): FactClaim => ({
  id: "fact-1",
  tenant_id: null,
  project: "vega",
  source_memory_id: "memory-1",
  evidence_archive_id: null,
  canonical_key: "vega-memory|database|sqlite",
  subject: "vega-memory",
  predicate: "database",
  claim_value: "sqlite",
  claim_text: "Vega Memory uses SQLite.",
  source: "hot_memory",
  status: "active",
  confidence: 0.8,
  valid_from: "2026-04-01T00:00:00.000Z",
  valid_to: null,
  temporal_precision: "day",
  invalidation_reason: null,
  created_at: "2026-04-03T00:00:00.000Z",
  updated_at: "2026-04-03T00:00:00.000Z",
  ...overrides
});

const installEmbeddingMock = (vector: number[]): (() => void) => {
  const originalFetch = globalThis.fetch;
  embeddingCache.clear();

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ embeddings: [vector] }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });

  return () => {
    embeddingCache.clear();
    globalThis.fetch = originalFetch;
  };
};

const createSessionService = (config: VegaConfig = baseConfig) => {
  const repository = new Repository(config.dbPath);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, new SearchEngine(repository, config), config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);

  return {
    repository,
    sessionService
  };
};

const getDatabase = (repository: Repository): Database.Database =>
  (repository as unknown as { db: Database.Database }).db;

test("inferProject returns directory basename when not a git repo", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-project-"));
  const { repository, sessionService } = createSessionService();

  try {
    assert.equal(sessionService.inferProject(tempDir), basename(tempDir));
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart returns correct structure with empty database", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-start-empty-"));
  const { repository, sessionService } = createSessionService();

  try {
    const result = await sessionService.sessionStart(tempDir);

    assert.equal(result.project, basename(tempDir));
    assert.deepEqual(result.active_tasks, []);
    assert.deepEqual(result.preferences, []);
    assert.deepEqual(result.context, []);
    assert.deepEqual(result.relevant, []);
    assert.deepEqual(result.recent_unverified, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.proactive_warnings, []);
    assert.equal(result.token_estimate, 0);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart loads preferences as global", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-start-preferences-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "preference-1",
        type: "preference",
        project: "shared",
        scope: "global",
        content: "Prefer concise summaries."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "context-1",
        type: "project_context",
        project,
        scope: "project"
      })
    );

    const result = await sessionService.sessionStart(tempDir);

    assert.equal(result.preferences.length, 1);
    assert.equal(result.preferences[0]?.id, "preference-1");
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart excludes archived preferences", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-start-archived-preferences-"));
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "preference-active",
        type: "preference",
        project: "shared",
        scope: "global",
        content: "Prefer concise summaries."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "preference-archived",
        type: "preference",
        project: "shared",
        scope: "global",
        content: "Archived preference should not load.",
        status: "archived"
      })
    );

    const result = await sessionService.sessionStart(tempDir);

    assert.deepEqual(
      result.preferences.map((memory) => memory.id),
      ["preference-active"]
    );
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart excludes archived project context", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-start-archived-context-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "context-active",
        type: "project_context",
        project
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "context-archived",
        type: "project_context",
        project,
        status: "archived"
      })
    );

    const result = await sessionService.sessionStart(tempDir);

    assert.deepEqual(
      result.context.map((memory) => memory.id),
      ["context-active"]
    );
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart loads active task_states for project", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-start-tasks-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "task-active",
        type: "task_state",
        project,
        title: "Active task",
        content: "Implement session service."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "task-archived",
        type: "task_state",
        project,
        status: "archived",
        title: "Archived task"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "task-other-project",
        type: "task_state",
        project: "other-project",
        title: "Other project task"
      })
    );

    const result = await sessionService.sessionStart(tempDir);

    assert.deepEqual(
      result.active_tasks.map((memory) => memory.id),
      ["task-active"]
    );
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart stays on hot-memory path when VM2 sidecars are disabled", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-start-hot-only-"));
  const project = basename(tempDir);
  const config: VegaConfig = {
    ...baseConfig,
    features: {
      factClaims: false,
      rawArchive: false,
      topicRecall: false,
      deepRecall: false
    }
  };
  const { repository, sessionService } = createSessionService(config);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "task-hot-only",
        type: "task_state",
        project,
        title: "Active hot task"
      })
    );
    getDatabase(repository).exec(`
      DROP TABLE IF EXISTS memory_topics;
      DROP TABLE IF EXISTS topics;
      DROP TABLE IF EXISTS fact_claims;
      DROP TABLE IF EXISTS raw_archives_fts;
      DROP TABLE IF EXISTS raw_archives;
    `);

    const result = await sessionService.sessionStart(tempDir);

    assert.deepEqual(
      result.active_tasks.map((memory) => memory.id),
      ["task-hot-only"]
    );
    assert.deepEqual(result.preferences, []);
    assert.deepEqual(result.context, []);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart excludes memories backed only by expired fact claims and warns on fact conflicts", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-fact-claims-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService({
    ...baseConfig,
    features: {
      factClaims: true
    }
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "task-visible",
        type: "task_state",
        project,
        title: "Visible task"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "task-hidden",
        type: "task_state",
        project,
        title: "Hidden task"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "context-conflict-source",
        type: "project_context",
        project,
        title: "Conflict source"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-hidden",
        project,
        source_memory_id: "task-hidden",
        subject: "vega-memory",
        predicate: "deployment",
        claim_value: "legacy-host",
        claim_text: "Vega Memory uses the legacy host.",
        status: "suspected_expired",
        canonical_key: "vega-memory|deployment|legacy-host"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-conflict-a",
        project,
        source_memory_id: "context-conflict-source",
        subject: "vega-memory",
        predicate: "database",
        claim_value: "sqlite",
        claim_text: "Vega Memory uses SQLite.",
        status: "conflict",
        canonical_key: "vega-memory|database|sqlite"
      })
    );
    repository.createFactClaim(
      createFactClaim({
        id: "fact-conflict-b",
        project,
        source_memory_id: "task-visible",
        subject: "vega-memory",
        predicate: "database",
        claim_value: "postgres",
        claim_text: "Vega Memory uses Postgres.",
        status: "conflict",
        canonical_key: "vega-memory|database|postgres"
      })
    );

    const result = await sessionService.sessionStart(tempDir);

    assert.deepEqual(
      result.active_tasks.map((memory) => memory.id),
      ["task-visible"]
    );
    assert.deepEqual(result.proactive_warnings, [
      "fact claim conflict: vega-memory database -> postgres | sqlite"
    ]);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionEnd creates session record", async () => {
  const restoreFetch = installEmbeddingMock([0.2, 0.8]);
  const { repository, sessionService } = createSessionService();

  try {
    await sessionService.sessionEnd("vega", "我们决定使用 SQLite。");

    const db = getDatabase(repository);
    const stored = db
      .prepare(
        "SELECT project, summary, memories_created FROM sessions ORDER BY ended_at DESC LIMIT 1"
      )
      .get() as { project: string; summary: string; memories_created: string } | undefined;

    assert.ok(stored);
    assert.equal(stored.project, "vega");
    assert.equal(stored.summary, "我们决定使用 SQLite。");
    assert.equal(JSON.parse(stored.memories_created).length, 1);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("sessionEnd keeps completed tasks active and decays importance to 0.2", async () => {
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "task-1",
        type: "task_state",
        project: "vega",
        importance: 0.9
      })
    );

    await sessionService.sessionEnd("vega", "Session completed.", ["task-1"]);

    const updated = repository.getMemory("task-1");
    assert.ok(updated);
    assert.equal(updated.importance, 0.2);
    assert.equal(updated.status, "active");
  } finally {
    repository.close();
  }
});

test("sessionStart scopes project memories to the provided tenant", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-start-tenant-scope-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "tenant-a-task",
        type: "task_state",
        project,
        tenant_id: "tenant-a",
        title: "Tenant A task"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "tenant-a-context",
        type: "project_context",
        project,
        tenant_id: "tenant-a",
        title: "Tenant A context"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "tenant-b-task",
        type: "task_state",
        project,
        tenant_id: "tenant-b",
        title: "Tenant B task"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "tenant-b-context",
        type: "project_context",
        project,
        tenant_id: "tenant-b",
        title: "Tenant B context"
      })
    );

    const result = await sessionService.sessionStart(tempDir, undefined, "tenant-a");

    assert.deepEqual(
      result.active_tasks.map((memory) => memory.id),
      ["tenant-a-task"]
    );
    assert.deepEqual(
      result.context.map((memory) => memory.id),
      ["tenant-a-context"]
    );
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionEnd rejects completed tasks from another tenant", async () => {
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "tenant-a-task",
        type: "task_state",
        project: "vega",
        tenant_id: "tenant-a",
        importance: 0.9
      })
    );

    await assert.rejects(
      () =>
        sessionService.sessionEnd(
          "vega",
          "Session completed.",
          ["tenant-a-task"],
          undefined,
          "tenant-b"
        ),
      /forbidden/
    );

    const updated = repository.getMemory("tenant-a-task");
    assert.ok(updated);
    assert.equal(updated.importance, 0.9);
  } finally {
    repository.close();
  }
});

test("sessionStart includes global pitfalls, decisions, and insights from other projects", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-start-global-relevant-"));
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "global-pitfall",
        type: "pitfall",
        project: "other-project",
        scope: "global",
        content: "Avoid opening the HTTP API without an API key."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "global-decision",
        type: "decision",
        project: "other-project",
        scope: "global",
        content: "Use better-sqlite3 for local persistence."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "global-insight",
        type: "insight",
        project: "other-project",
        scope: "global",
        content: "Offline cache fallback keeps the client usable."
      })
    );

    const result = await sessionService.sessionStart(tempDir);
    const relevantIds = result.relevant.map((memory) => memory.id).sort();

    assert.deepEqual(relevantIds, [
      "global-decision",
      "global-insight",
      "global-pitfall"
    ]);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart task hints recall other projects but prefer current project matches", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-start-cross-project-"));
  const project = basename(tempDir);
  const restoreFetch = installEmbeddingMock([0.6, 0.4]);
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "project-match",
        type: "decision",
        project,
        title: "Current project match",
        content: "SQLite cache fixes keep the current project stable.",
        importance: 0.6,
        verified: "verified"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "other-match",
        type: "decision",
        project: "other-project",
        title: "Other project match",
        content: "SQLite cache fixes keep another project stable.",
        importance: 0.6,
        verified: "verified"
      })
    );

    const result = await sessionService.sessionStart(tempDir, "SQLite cache fixes");
    const relevantIds = result.relevant.map((memory) => memory.id);

    assert.equal(relevantIds.includes("project-match"), true);
    assert.equal(relevantIds.includes("other-match"), true);
    assert.equal(
      relevantIds.indexOf("project-match") < relevantIds.indexOf("other-match"),
      true
    );
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart scopes recent unverified memories and conflicts to the project or global scope", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-scope-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "project-unverified",
        project,
        verified: "unverified",
        created_at: "2026-04-03T03:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "global-unverified",
        type: "preference",
        project: "shared",
        scope: "global",
        verified: "unverified",
        created_at: "2026-04-03T02:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "other-unverified",
        project: "other-project",
        verified: "unverified",
        created_at: "2026-04-03T04:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "project-conflict",
        project,
        verified: "conflict"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "other-conflict",
        project: "other-project",
        verified: "conflict"
      })
    );

    const result = await sessionService.sessionStart(tempDir);

    assert.deepEqual(
      result.recent_unverified.map((memory) => memory.id),
      ["project-unverified", "global-unverified"]
    );
    assert.deepEqual(
      result.conflicts.map((memory) => memory.id).sort(),
      ["project-conflict"]
    );
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart keeps token_estimate within budget and excludes conflicts from normal context", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-budget-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService({
    ...baseConfig,
    tokenBudget: 180
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "preference-big",
        type: "preference",
        project: "shared",
        scope: "global",
        verified: "verified",
        content: "P".repeat(300)
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "task-big",
        type: "task_state",
        project,
        verified: "verified",
        content: "T".repeat(300)
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "context-big",
        type: "project_context",
        project,
        verified: "verified",
        content: "C".repeat(300)
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "global-conflict",
        type: "decision",
        project: "shared",
        scope: "global",
        verified: "conflict",
        content: "Conflict memories should stay out of relevant."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "global-decision",
        type: "decision",
        project: "shared",
        scope: "global",
        verified: "verified",
        content: "Verified global decision should remain eligible."
      })
    );

    const result = await sessionService.sessionStart(tempDir);

    assert.equal(result.token_estimate <= 180, true);
    assert.equal(result.relevant.some((memory) => memory.id === "global-conflict"), false);
    assert.equal(result.conflicts.some((memory) => memory.id === "global-conflict"), true);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart light mode loads only the minimal payload and skips semantic recall", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-light-minimal-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService({
    ...baseConfig,
    tokenBudget: 400
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "pref-light",
        type: "preference",
        project: "shared",
        scope: "global",
        verified: "verified",
        importance: 0.9,
        content: "Prefer the smallest safe preload."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "task-light",
        type: "task_state",
        project,
        verified: "verified",
        content: "Ship the light preload path."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "context-standard-only",
        type: "project_context",
        project,
        verified: "verified",
        content: "Standard mode should still load project context."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "conflict-light",
        type: "decision",
        project,
        verified: "conflict",
        content: "Two loaders disagree on context ordering.",
        created_at: "2026-04-03T04:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "unverified-standard-only",
        type: "decision",
        project,
        verified: "unverified",
        content: "This should stay out of light mode.",
        created_at: "2026-04-03T05:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "warning-insight",
        type: "insight",
        project,
        verified: "verified",
        tags: ["sqlite", "latency"],
        content: "SQLite semantic preload slows recall."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "relevant-standard-only",
        type: "decision",
        project: "other-project",
        scope: "global",
        verified: "verified",
        title: "Relevant standard memory",
        content: "SQLite preload tuning helps the active repository stay fast."
      })
    );

    const lightResult = await sessionService.sessionStart(tempDir, "sqlite latency", undefined, "light");

    assert.deepEqual(
      lightResult.preferences.map((memory) => memory.id),
      ["pref-light"]
    );
    assert.deepEqual(
      lightResult.active_tasks.map((memory) => memory.id),
      ["task-light"]
    );
    assert.deepEqual(
      lightResult.conflicts.map((memory) => memory.id),
      ["conflict-light"]
    );
    assert.deepEqual(lightResult.context, []);
    assert.deepEqual(lightResult.relevant, []);
    assert.deepEqual(lightResult.relevant_wiki_pages, []);
    assert.deepEqual(lightResult.recent_unverified, []);
    assert.equal(lightResult.wiki_drafts_pending, 0);
    assert.deepEqual(lightResult.proactive_warnings, [
      "SQLite semantic preload slows recall."
    ]);

    const restoreFetch = installEmbeddingMock([0.6, 0.4]);

    try {
      const standardResult = await sessionService.sessionStart(
        tempDir,
        "sqlite latency",
        undefined,
        "standard"
      );

      assert.deepEqual(
        standardResult.context.map((memory) => memory.id),
        ["context-standard-only"]
      );
      assert.deepEqual(
        standardResult.recent_unverified.map((memory) => memory.id),
        ["unverified-standard-only"]
      );
      assert.equal(
        standardResult.relevant.some((memory) => memory.id === "relevant-standard-only"),
        true
      );
      assert.equal(standardResult.token_estimate > lightResult.token_estimate, true);
    } finally {
      restoreFetch();
    }
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart light mode keeps token_estimate within a quarter of tokenBudget", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-light-budget-"));
  const project = basename(tempDir);
  const tokenBudget = 200;
  const { repository, sessionService } = createSessionService({
    ...baseConfig,
    tokenBudget
  });

  try {
    repository.createMemory(
      createStoredMemory({
        id: "pref-big",
        type: "preference",
        project: "shared",
        scope: "global",
        verified: "verified",
        importance: 0.9,
        content: "P".repeat(300)
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "task-big",
        type: "task_state",
        project,
        verified: "verified",
        content: "T".repeat(300)
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "conflict-big",
        type: "decision",
        project,
        verified: "conflict",
        content: "C".repeat(300)
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "warning-big",
        type: "insight",
        project,
        verified: "verified",
        tags: ["budget"],
        content: "W".repeat(300)
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "context-standard-only",
        type: "project_context",
        project,
        verified: "verified",
        content: "CTX".repeat(120)
      })
    );

    const result = await sessionService.sessionStart(tempDir, "budget", undefined, "light");

    assert.equal(result.context.length, 0);
    assert.equal(result.relevant.length, 0);
    assert.equal(result.recent_unverified.length, 0);
    assert.equal(result.token_estimate <= Math.floor(tokenBudget * 0.25), true);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart L0 returns only preferences within the identity budget", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-l0-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "pref-l0",
        type: "preference",
        project: "shared",
        scope: "global",
        verified: "verified",
        importance: 0.95,
        content: "Prefer concise summaries for coding tasks."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "task-l0",
        type: "task_state",
        project,
        verified: "verified",
        content: "Implement the recall tier feature."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "context-l0",
        type: "project_context",
        project,
        verified: "verified",
        content: "Project context should not load in L0."
      })
    );

    const result = await sessionService.sessionStart(tempDir, undefined, undefined, "L0");

    assert.deepEqual(
      result.preferences.map((memory) => memory.id),
      ["pref-l0"]
    );
    assert.deepEqual(result.active_tasks, []);
    assert.deepEqual(result.context, []);
    assert.deepEqual(result.relevant, []);
    assert.deepEqual(result.recent_unverified, []);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.token_estimate <= 50, true);
    assert.equal(result.deep_recall, undefined);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart L1 and L2 preserve light and standard behavior", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-layer-aliases-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService();

  try {
    repository.createMemory(
      createStoredMemory({
        id: "pref-layer",
        type: "preference",
        project: "shared",
        scope: "global",
        verified: "verified",
        content: "Prefer WAL mode for SQLite."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "task-layer",
        type: "task_state",
        project,
        verified: "verified",
        content: "Add explicit recall tiers."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "context-layer",
        type: "project_context",
        project,
        verified: "verified",
        content: "Standard mode should still load project context."
      })
    );

    const light = await sessionService.sessionStart(tempDir, "recall tiers", undefined, "light");
    const l1 = await sessionService.sessionStart(tempDir, "recall tiers", undefined, "L1");
    const standard = await sessionService.sessionStart(
      tempDir,
      "recall tiers",
      undefined,
      "standard"
    );
    const l2 = await sessionService.sessionStart(tempDir, "recall tiers", undefined, "L2");

    assert.deepEqual(l1, light);
    assert.deepEqual(l2, standard);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionStart L3 adds deep recall evidence on top of the standard bundle", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-session-l3-"));
  const project = basename(tempDir);
  const { repository, sessionService } = createSessionService();
  const archiveService = new ArchiveService(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "memory-l3",
        type: "decision",
        project,
        title: "Backup validation",
        content: "Hot summary for backup validation.",
        verified: "verified"
      })
    );
    archiveService.store(
      "Full tool log with backup evidence and restore commands.",
      "tool_log",
      project,
      {
        source_memory_id: "memory-l3",
        title: "Backup tool log"
      }
    );

    const standard = await sessionService.sessionStart(
      tempDir,
      "backup evidence",
      undefined,
      "L2"
    );
    const deep = await sessionService.sessionStart(tempDir, "backup evidence", undefined, "L3");

    assert.deepEqual(deep.preferences, standard.preferences);
    assert.deepEqual(deep.active_tasks, standard.active_tasks);
    assert.deepEqual(deep.context, standard.context);
    assert.deepEqual(deep.relevant, standard.relevant);
    assert.ok(deep.deep_recall);
    assert.equal(deep.deep_recall.injected_into_session, true);
    assert.equal(deep.deep_recall.results.length, 1);
    assert.equal(deep.deep_recall.results[0]?.archive_type, "tool_log");
    assert.match(deep.deep_recall.results[0]?.content ?? "", /restore commands/);
    assert.equal(deep.token_estimate > standard.token_estimate, true);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("sessionEnd extracts decision from summary containing 决定", async () => {
  const restoreFetch = installEmbeddingMock([0.4, 0.6]);
  const { repository, sessionService } = createSessionService();

  try {
    await sessionService.sessionEnd("vega", "我们决定使用 SQLite 作为本地存储。");

    const decisions = repository.listMemories({
      project: "vega",
      type: "decision",
      limit: 10
    });

    assert.equal(decisions.length, 1);
    assert.match(decisions[0]?.content ?? "", /决定/);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("sessionEnd extracts pitfall from summary containing 修复", async () => {
  const restoreFetch = installEmbeddingMock([0.7, 0.3]);
  const { repository, sessionService } = createSessionService();

  try {
    await sessionService.sessionEnd("vega", "我们修复了 SQLite 连接泄漏问题。");

    const pitfalls = repository.listMemories({
      project: "vega",
      type: "pitfall",
      limit: 10
    });

    assert.equal(pitfalls.length, 1);
    assert.match(pitfalls[0]?.content ?? "", /修复/);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("sessionEnd records only newly created memories in memories_created", async () => {
  const restoreFetch = installEmbeddingMock([0.4, 0.6]);
  const { repository, sessionService } = createSessionService();

  try {
    await sessionService.sessionEnd("vega", "我们决定使用 SQLite 作为本地存储。");
    await sessionService.sessionEnd("vega", "我们决定使用 SQLite 作为本地存储。");

    const db = getDatabase(repository);
    const sessions = db
      .prepare(
        "SELECT memories_created FROM sessions ORDER BY ended_at ASC"
      )
      .all() as Array<{ memories_created: string }>;

    assert.equal(JSON.parse(sessions[0]?.memories_created ?? "[]").length, 1);
    assert.equal(JSON.parse(sessions[1]?.memories_created ?? "[]").length, 0);
  } finally {
    restoreFetch();
    repository.close();
  }
});
