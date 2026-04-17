import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { INTENT_REQUEST_SCHEMA } from "../core/contracts/intent.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type { ContextResolveResponse } from "../retrieval/orchestrator.js";
import { createContextResolveHttpHandler, createContextResolveMcpTool } from "../retrieval/context-resolve-handler.js";
import { Repository } from "../db/repository.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { createIngestEventMcpTool } from "../ingestion/ingest-event-handler.js";
import { RAW_INBOX_TABLE, applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { SearchEngine } from "../search/engine.js";

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");
const cliModuleUrl = pathToFileURL(cliPath).href;
const childBaseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("VEGA_") && key !== "OLLAMA_BASE_URL" && key !== "OLLAMA_MODEL"
  )
);
const cliBootstrap = `process.argv.splice(1, 0, ${JSON.stringify(cliPath)}); await import(${JSON.stringify(cliModuleUrl)});`;

const runCli = (args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync(process.execPath, ["--input-type=module", "-e", cliBootstrap, "--", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...childBaseEnv,
      ...env
    }
  });

const createApiHarness = async (apiKey?: string): Promise<{
  baseUrl: string;
  cleanup(): Promise<void>;
}> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-wiring-api-"));
  const config: VegaConfig = {
    dbPath: join(tempDir, "memory.db"),
    ollamaBaseUrl: "http://localhost:99999",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    shardingEnabled: false,
    backupRetentionDays: 7,
    apiPort: 0,
    apiKey,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(tempDir, "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    observerEnabled: false,
    dbEncryption: false
  };
  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(repository, memoryService, recallService, config);
  const compactService = new CompactService(repository, config);
  const server = createAPIServer(
    {
      repository,
      memoryService,
      recallService,
      sessionService,
      compactService
    },
    config
  );
  const port = await server.start(0);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async cleanup(): Promise<void> {
      await server.stop();
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
};

test("CLI help output includes the replay command", () => {
  const output = runCli(["--help"], {
    VEGA_DB_PATH: ":memory:",
    OLLAMA_BASE_URL: "http://localhost:99999"
  });

  assert.match(output, /\breplay\b/);
});

test("ingest_event and context.resolve MCP factories expose the expected tool names", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const ingestEventTool = createIngestEventMcpTool(db);
    const contextResolveTool = createContextResolveMcpTool({
      resolve() {
        return {
          checkpoint_id: "checkpoint-1",
          bundle_digest: "bundle-1",
          bundle: {
            schema_version: "1.0",
            bundle_digest: "bundle-1",
            sections: []
          },
          sufficiency_hint: "likely_sufficient",
          profile_used: "lookup",
          ranker_version: "v1.0"
        } satisfies ContextResolveResponse;
      }
    } as never);

    assert.equal(ingestEventTool.name, "ingest_event");
    assert.equal(contextResolveTool.name, "context.resolve");
  } finally {
    db.close();
  }
});

test("intent request schema requires prev_checkpoint_id only for followup", () => {
  const followupWithoutPrev = INTENT_REQUEST_SCHEMA.safeParse({
    intent: "followup",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory"
  });
  const followupWithPrev = INTENT_REQUEST_SCHEMA.safeParse({
    intent: "followup",
    surface: "codex",
    session_id: "session-1",
    project: "vega-memory",
    cwd: "/Users/johnmacmini/workspace/vega-memory",
    prev_checkpoint_id: "checkpoint-1"
  });

  assert.equal(followupWithoutPrev.success, false);
  assert.equal(followupWithPrev.success, true);

  for (const intent of ["lookup", "bootstrap", "evidence"] as const) {
    const result = INTENT_REQUEST_SCHEMA.safeParse({
      intent,
      surface: "codex",
      session_id: "session-1",
      project: "vega-memory",
      cwd: "/Users/johnmacmini/workspace/vega-memory"
    });

    assert.equal(result.success, true);
  }
});

test("POST /ingest_event and POST /context_resolve are mounted on the HTTP API", async () => {
  const harness = await createApiHarness();

  try {
    const ingestResponse = await fetch(`${harness.baseUrl}/ingest_event`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const contextResolveResponse = await fetch(`${harness.baseUrl}/context_resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    assert.notEqual(ingestResponse.status, 404);
    assert.notEqual(contextResolveResponse.status, 404);
  } finally {
    await harness.cleanup();
  }
});

test("POST /ingest_event returns 401 without authorization when apiKey is configured", async () => {
  const harness = await createApiHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/ingest_event`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    assert.equal(response.status, 401);
  } finally {
    await harness.cleanup();
  }
});

test("POST /context_resolve returns 401 without authorization when apiKey is configured", async () => {
  const harness = await createApiHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/context_resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });

    assert.equal(response.status, 401);
  } finally {
    await harness.cleanup();
  }
});

test("raw inbox migration remains idempotent across repeated startup calls", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);
    applyRawInboxMigration(db);

    const table = db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      RAW_INBOX_TABLE
    );

    assert.equal(table?.name, RAW_INBOX_TABLE);
  } finally {
    db.close();
  }
});

test("context resolve HTTP handler returns a 400 validation response for invalid input", async () => {
  const handler = createContextResolveHttpHandler({
    resolve() {
      throw new Error("should not be called");
    }
  } as never);

  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };

  await handler({ body: {} } as never, response as never);

  assert.equal(response.statusCode, 400);
  assert.equal((response.body as { error?: string }).error, "ValidationError");
});

test("context resolve HTTP handler returns 400 when followup omits prev_checkpoint_id", async () => {
  const handler = createContextResolveHttpHandler({
    resolve() {
      throw new Error("should not be called");
    }
  } as never);

  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };

  await handler(
    {
      body: {
        intent: "followup",
        surface: "codex",
        session_id: "session-1",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory"
      }
    } as never,
    response as never
  );

  assert.equal(response.statusCode, 400);
  assert.equal((response.body as { error?: string }).error, "ValidationError");
  assert.match(
    String((response.body as { detail?: string }).detail),
    /prev_checkpoint_id is required for followup intent/
  );
});
