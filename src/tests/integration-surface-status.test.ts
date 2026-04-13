import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { buildIntegrationSurfaceStatuses } from "../core/integration-surface-status.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";

const timestamp = "2026-04-14T08:00:00.000Z";

const createConfig = (dbPath: string, overrides: Partial<VegaConfig> = {}): VegaConfig => ({
  dbPath,
  ollamaBaseUrl: "http://localhost:99999",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: "top-secret",
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: join(tmpdir(), "vega-status-cache.db"),
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  dbEncryption: false,
  ...overrides
});

const createStoredMemory = (id: string, overrides: Partial<Memory> = {}): Memory => ({
  id,
  type: "decision",
  project: "vega",
  title: `Memory ${id}`,
  content: `Content for ${id}`,
  summary: null,
  embedding: null,
  importance: 0.5,
  source: "explicit",
  tags: ["status"],
  created_at: timestamp,
  updated_at: timestamp,
  accessed_at: timestamp,
  access_count: 0,
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

test("integration surface statuses treat tagged recent activity as active and legacy activity as unknown", async () => {
  const previousHome = process.env.HOME;
  const tempDir = mkdtempSync(join(tmpdir(), "vega-surface-status-"));
  const dbPath = join(tempDir, "memory.db");
  const repository = new Repository(dbPath);
  const config = createConfig(dbPath);

  process.env.HOME = tempDir;
  mkdirSync(join(tempDir, ".codex"), { recursive: true });
  writeFileSync(
    join(tempDir, ".codex", "AGENTS.md"),
    [
      "<!-- Vega Memory System: START -->",
      "Rules for Codex CLI:",
      "- use vega cli",
      "<!-- Vega Memory System: END -->",
      ""
    ].join("\n"),
    "utf8"
  );

  try {
    repository.createMemory(
      createStoredMemory("cli-surface", {
        source_context: {
          actor: "user",
          channel: "cli",
          device_id: "device-cli",
          device_name: "CLI Device",
          platform: "darwin",
          surface: "cli",
          integration: "vega-cli"
        }
      })
    );
    repository.createMemory(
      createStoredMemory("legacy-memory", {
        updated_at: "2026-03-20T08:00:00.000Z",
        source_context: {
          actor: "legacy",
          channel: "mcp",
          device_id: "device-legacy",
          device_name: "Legacy Device",
          platform: "darwin"
        }
      })
    );
    repository.logPerformance({
      timestamp,
      tenant_id: null,
      operation: "recall",
      detail: JSON.stringify({
        query: "api activity",
        surface: "api",
        integration: "http"
      }),
      latency_ms: 20,
      memory_count: 1,
      result_count: 1,
      avg_similarity: 0.8,
      result_types: ["decision"],
      bm25_result_count: 1
    });

    const statuses = await buildIntegrationSurfaceStatuses({
      config,
      repository
    });
    const cli = statuses.find((status) => status.surface === "cli");
    const api = statuses.find((status) => status.surface === "api");
    const cursor = statuses.find((status) => status.surface === "cursor");
    const codex = statuses.find((status) => status.surface === "codex");

    assert.equal(cli?.observed_activity_windows.window_7d.status, "active");
    assert.equal(api?.observed_activity_windows.window_7d.status, "active");
    assert.equal(cursor?.observed_activity_windows.window_7d.status, "unknown");
    assert.equal(codex?.managed_setup_status, "configured");
  } finally {
    process.env.HOME = previousHome;
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
