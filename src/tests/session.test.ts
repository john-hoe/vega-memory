import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import type Database from "better-sqlite3";

import type { VegaConfig } from "../config.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
};

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
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
  ...overrides
});

const installEmbeddingMock = (vector: number[]): (() => void) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ embeddings: [vector] }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });

  return () => {
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
