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
import { SearchEngine } from "../search/engine.js";

interface TestHarness {
  baseUrl: string;
  cleanup(): Promise<void>;
}

const createHarness = async (apiKey?: string, overrides: Partial<VegaConfig> = {}): Promise<TestHarness> => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-metrics-api-"));
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
    dbEncryption: false,
    metricsEnabled: true,
    ...overrides
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

test("GET /metrics exposes all batch 10a vega metric families with HELP and TYPE lines", async () => {
  const harness = await createHarness("top-secret");

  try {
    const response = await fetch(`${harness.baseUrl}/metrics`, {
      headers: {
        authorization: "Bearer top-secret"
      }
    });
    const body = await response.text();

    assert.equal(response.status, 200);

    for (const [name, type] of [
      ["vega_retrieval_calls_total", "counter"],
      ["vega_retrieval_nonempty_total", "counter"],
      ["vega_usage_ack_total", "counter"],
      ["vega_usage_followup_loop_override_total", "counter"],
      ["vega_circuit_breaker_state", "gauge"],
      ["vega_circuit_breaker_trips_total", "counter"],
      ["vega_raw_inbox_rows", "gauge"],
      ["vega_raw_inbox_oldest_age_seconds", "gauge"]
    ] as const) {
      assert.match(body, new RegExp(`# HELP ${name} `));
      assert.match(body, new RegExp(`# TYPE ${name} ${type}`));
    }
  } finally {
    await harness.cleanup();
  }
});
