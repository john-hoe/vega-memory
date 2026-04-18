import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createAPIServer } from "../api/server.js";
import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { buildPhase8Status } from "../usage/phase8-status.js";
import {
  createAckStore,
  createCheckpointFailureStore,
  createCheckpointStore
} from "../usage/index.js";
import { SearchEngine } from "../search/engine.js";

const createConfig = (dbPath: string, apiKey?: string): VegaConfig => ({
  dbPath,
  ollamaBaseUrl: "http://localhost:99999",
  ollamaModel: "bge-m3",
  tokenBudget: 2_000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  apiPort: 0,
  apiKey,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: join(tmpdir(), `vega-cache-${Math.random().toString(16).slice(2)}.db`),
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  dbEncryption: false
});

const createApiHarness = async (apiKey?: string): Promise<{
  baseUrl: string;
  cleanup(): Promise<void>;
}> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-phase8-status-"));
  const config = createConfig(join(tempDir, "memory.db"), apiKey);
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

test("buildPhase8Status reports sqlite readiness when all stores are available", () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    const status = buildPhase8Status({
      isPostgres: false,
      checkpointStore: createCheckpointStore(db),
      ackStore: createAckStore(db),
      checkpointFailureStore: createCheckpointFailureStore(db)
    });

    assert.deepEqual(status, {
      backend: "sqlite",
      persistence: {
        checkpoint_store: "enabled",
        ack_store: "enabled",
        checkpoint_failure_store: "enabled"
      },
      phase8_ready: true
    });
  } finally {
    db.close();
  }
});

test("buildPhase8Status reports postgres mode as persistence-disabled", () => {
  const status = buildPhase8Status({
    isPostgres: true,
    checkpointStore: undefined,
    ackStore: undefined,
    checkpointFailureStore: undefined
  });

  assert.deepEqual(status, {
    backend: "postgres",
    persistence: {
      checkpoint_store: "disabled-postgres",
      ack_store: "disabled-postgres",
      checkpoint_failure_store: "disabled-postgres"
    },
    phase8_ready: false
  });
});

test("GET /api/phase8_status returns status metadata without requiring auth", async () => {
  const harness = await createApiHarness("secret-key");

  try {
    const response = await fetch(`${harness.baseUrl}/api/phase8_status`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      backend: "sqlite",
      persistence: {
        checkpoint_store: "enabled",
        ack_store: "enabled",
        checkpoint_failure_store: "enabled"
      },
      phase8_ready: true
    });
  } finally {
    await harness.cleanup();
  }
});
