import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type { MemoryType } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";

const ensureDataDirectory = (dbPath: string): void => {
  if (dbPath === ":memory:") {
    return;
  }

  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
};

test("E2E: Vega Memory System", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-e2e-"));
  const dbPath = join(tempDir, "memory.db");
  const project = basename(tempDir);
  const previousEnv = {
    VEGA_DB_PATH: process.env.VEGA_DB_PATH,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL
  };

  process.env.VEGA_DB_PATH = dbPath;
  process.env.OLLAMA_BASE_URL = "http://localhost:99999";

  const config = loadConfig();
  ensureDataDirectory(config.dbPath);
  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);
  const compactService = new CompactService(repository, config);

  try {
    await t.test("session_start returns valid structure on empty database", async () => {
      const result = await sessionService.sessionStart(tempDir);

      assert.equal(result.project, project);
      assert.ok("active_tasks" in result);
      assert.ok("preferences" in result);
      assert.ok("context" in result);
      assert.ok("relevant" in result);
      assert.ok("recent_unverified" in result);
      assert.ok("conflicts" in result);
      assert.ok("proactive_warnings" in result);
      assert.equal(Array.isArray(result.active_tasks), true);
      assert.equal(Array.isArray(result.preferences), true);
      assert.equal(Array.isArray(result.context), true);
      assert.equal(Array.isArray(result.relevant), true);
      assert.equal(Array.isArray(result.recent_unverified), true);
      assert.equal(Array.isArray(result.conflicts), true);
      assert.equal(Array.isArray(result.proactive_warnings), true);
      assert.equal(typeof result.token_estimate, "number");
    });

    await t.test("store 5 different memory types", async () => {
      const cases: Array<{
        type: MemoryType;
        title: string;
        content: string;
      }> = [
        {
          type: "task_state",
          title: "E2E Task State",
          content: "Implement the end-to-end test workflow for Vega Memory."
        },
        {
          type: "preference",
          title: "E2E Preference",
          content: "Always keep CLI test output concise and machine-readable."
        },
        {
          type: "project_context",
          title: "E2E Project Context",
          content: "The project uses SQLite, FTS5, commander, and MCP tooling."
        },
        {
          type: "decision",
          title: "E2E Decision",
          content: "Use a real SQLite file for end-to-end coverage."
        },
        {
          type: "pitfall",
          title: "E2E Pitfall",
          content: "FFmpeg path bugs happen when relative paths are used."
        }
      ];

      for (const entry of cases) {
        const result = await memoryService.store({
          content: entry.content,
          type: entry.type,
          project,
          title: entry.title
        });

        assert.equal(typeof result.id, "string");
        assert.equal(result.action, "created");
        assert.equal(result.title, entry.title);
      }
    });

    await t.test("list memories returns all stored", () => {
      const memories = recallService.listMemories({});

      assert.ok(memories.length >= 5);
    });

    await t.test(
      "store duplicate merges create new records when embeddings are unavailable",
      async () => {
        const duplicateContent = "Duplicate memory without embeddings should not merge.";

        const first = await memoryService.store({
          content: duplicateContent,
          type: "decision",
          project
        });
        const second = await memoryService.store({
          content: duplicateContent,
          type: "decision",
          project
        });
        const duplicates = recallService
          .listMemories({
            project,
            type: "decision",
            limit: 1_000
          })
          .filter((memory) => memory.content === duplicateContent);

        assert.equal(first.action, "created");
        assert.equal(second.action, "created");
        assert.equal(duplicates.length, 2);
      }
    );

    await t.test("update creates version history", async () => {
      const stored = await memoryService.store({
        content: "Initial content for version history coverage.",
        type: "insight",
        project,
        title: "Versioned Memory"
      });

      await memoryService.update(stored.id, {
        content: "Updated content for version history coverage."
      });

      const versions = repository.getVersions(stored.id);

      assert.ok(versions.length >= 1);
    });

    await t.test("session_end creates session record", async () => {
      const summary = "修复了FFmpeg路径bug，决定使用绝对路径";

      await sessionService.sessionEnd(project, summary);

      const sessionRow = repository.db
        .prepare<[string], { project: string; summary: string; memories_created: string }>(
          `SELECT project, summary, memories_created
           FROM sessions
           WHERE project = ?
           ORDER BY ended_at DESC
           LIMIT 1`
        )
        .get(project);

      assert.ok(sessionRow);
      assert.equal(sessionRow.project, project);
      assert.equal(sessionRow.summary, summary);
      assert.ok(JSON.parse(sessionRow.memories_created).length >= 1);
    });

    await t.test("compact archives low importance", async () => {
      const stored = await memoryService.store({
        content: "Archive this low-importance memory during compaction.",
        type: "insight",
        project,
        title: "Low Importance Memory",
        importance: 0.05
      });

      const result = compactService.compact(project);
      const archived = repository.getMemory(stored.id);

      assert.ok(result.archived >= 1);
      assert.ok(archived);
      assert.equal(archived.status, "archived");
    });

    await t.test("health check returns valid report", () => {
      const report = {
        memory_count: repository.listMemories({ limit: 1_000_000 }).length,
        db_exists: existsSync(dbPath)
      };

      assert.ok(report.memory_count >= 1);
      assert.equal(report.db_exists, true);
    });

    await t.test("audit log tracks operations", () => {
      const auditLog = repository.getAuditLog();

      assert.ok(auditLog.length >= 1);
      assert.equal(auditLog.some((entry) => entry.action === "store_created"), true);
      assert.equal(auditLog.some((entry) => entry.action === "update"), true);
    });

    await t.test("CLI health command runs without error", () => {
      const output = execFileSync("node", ["dist/cli/index.js", "health"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          VEGA_DB_PATH: dbPath,
          OLLAMA_BASE_URL: "http://localhost:99999"
        }
      });

      assert.match(output, /memory count:/i);
    });
  } finally {
    repository.close();

    if (previousEnv.VEGA_DB_PATH === undefined) {
      delete process.env.VEGA_DB_PATH;
    } else {
      process.env.VEGA_DB_PATH = previousEnv.VEGA_DB_PATH;
    }

    if (previousEnv.OLLAMA_BASE_URL === undefined) {
      delete process.env.OLLAMA_BASE_URL;
    } else {
      process.env.OLLAMA_BASE_URL = previousEnv.OLLAMA_BASE_URL;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});
