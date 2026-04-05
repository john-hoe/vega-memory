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
import { TeamService } from "../core/team.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { PluginLoader } from "../plugins/loader.js";
import { TemplateMarketplace } from "../plugins/marketplace.js";
import { SearchEngine } from "../search/engine.js";
import { mountDashboard } from "../web/dashboard.js";

const createConfig = (dbPath: string, overrides: Partial<VegaConfig> = {}): VegaConfig => ({
  dbPath,
  ollamaBaseUrl: "http://localhost:99999",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  backupRetentionDays: 7,
  apiPort: 0,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: join(tmpdir(), "vega-platform-cache.db"),
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  ...overrides
});

test("PluginLoader.listPlugins returns empty for empty dir", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-plugins-empty-"));
  const loader = new PluginLoader(tempDir);

  try {
    assert.deepEqual(loader.listPlugins(), []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TemplateMarketplace.listTemplates returns starter templates", async () => {
  const marketplace = new TemplateMarketplace(createConfig(":memory:"));
  const templates = await marketplace.listTemplates();

  assert.deepEqual(
    templates.map((template) => template.name),
    ["frontend-dev", "backend-dev", "devops"]
  );
});

test("TeamService.createTeam and listMembers", () => {
  const repository = new Repository(":memory:");
  const teamService = new TeamService(repository);

  try {
    const team = teamService.createTeam("alpha-team", "owner-1");
    teamService.addMember(team.id, "member-1", "member");

    const members = teamService.listMembers(team.id);

    assert.equal(team.name, "alpha-team");
    assert.deepEqual(
      members.map((member) => `${member.user_id}:${member.role}`),
      ["owner-1:admin", "member-1:member"]
    );
  } finally {
    repository.close();
  }
});

test("Dashboard HTML is served", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-dashboard-"));
  const dbPath = join(tempDir, "memory.db");
  const config = createConfig(dbPath, {
    apiKey: "top-secret"
  });
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

  try {
    mountDashboard(server.app, repository, config);
    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Vega Memory Dashboard/);
  } finally {
    await server.stop();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
