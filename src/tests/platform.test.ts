import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { DASHBOARD_AUTH_COOKIE } from "../api/auth.js";
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
  shardingEnabled: false,
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

test("PluginLoader ignores plugin entries that escape the plugin directory", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-plugins-traversal-"));
  const pluginDir = join(tempDir, "unsafe-plugin");
  const escapeEntryPath = join(tempDir, "escape.js");
  const loader = new PluginLoader(tempDir);
  const repository = new Repository(":memory:");

  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify({
      main: "../escape.js",
      name: "unsafe-plugin",
      version: "0.1.0"
    }),
    "utf8"
  );
  writeFileSync(
    escapeEntryPath,
    "export default { name: 'unsafe-plugin', version: '0.1.0', init() {} };",
    "utf8"
  );

  try {
    assert.deepEqual(loader.listPlugins(), []);
    assert.deepEqual(
      await loader.loadPlugins({
        config: createConfig(":memory:"),
        memoryService: {} as MemoryService,
        recallService: {} as RecallService,
        registerTool: () => {},
        repository
      }),
      []
    );
  } finally {
    repository.close();
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
      members.map((member) => `${member.user_id}:${member.role}`).sort(),
      ["member-1:member", "owner-1:admin"]
    );
  } finally {
    repository.close();
  }
});

test("TeamService.checkPermission denies unknown actions and restricts readonly members", () => {
  const repository = new Repository(":memory:");
  const teamService = new TeamService(repository);

  try {
    const team = teamService.createTeam("beta-team", "owner-1");
    teamService.addMember(team.id, "member-1", "member");
    teamService.addMember(team.id, "readonly-1", "readonly");

    assert.equal(teamService.checkPermission("member-1", team.id, "update_memory"), true);
    assert.equal(teamService.checkPermission("member-1", team.id, "transfer_ownership"), false);
    assert.equal(teamService.checkPermission("member-1", team.id, "unknown_future_action"), false);
    assert.equal(teamService.checkPermission("readonly-1", team.id, "list_memories"), true);
    assert.equal(teamService.checkPermission("readonly-1", team.id, "delete_memory"), false);
  } finally {
    repository.close();
  }
});

test("Dashboard requires login and serves HTML after authentication", async () => {
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
    const baseUrl = `http://127.0.0.1:${port}`;
    const unauthorizedResponse = await fetch(`${baseUrl}/`);
    const unauthorizedHtml = await unauthorizedResponse.text();
    const loginResponse = await fetch(`${baseUrl}/dashboard/login`, {
      method: "POST",
      body: new URLSearchParams({
        apiKey: "top-secret"
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      redirect: "manual"
    });
    const cookie = loginResponse.headers.get("set-cookie");
    const sessionToken = cookie?.match(
      new RegExp(`(?:^|\\s|,)${DASHBOARD_AUTH_COOKIE}=([^;]+)`)
    )?.[1];
    const response = await fetch(`${baseUrl}/`, {
      headers: {
        cookie: cookie ?? ""
      }
    });
    const html = await response.text();
    const apiResponse = await fetch(`${baseUrl}/api/health`, {
      headers: {
        cookie: cookie ?? ""
      }
    });
    const logoutResponse = await fetch(`${baseUrl}/dashboard/logout`, {
      method: "POST",
      headers: {
        cookie: cookie ?? ""
      },
      redirect: "manual"
    });
    const relockedResponse = await fetch(`${baseUrl}/`, {
      headers: {
        cookie: cookie ?? ""
      }
    });
    const apiAfterLogout = await fetch(`${baseUrl}/api/health`, {
      headers: {
        cookie: cookie ?? ""
      }
    });

    assert.equal(unauthorizedResponse.status, 401);
    assert.match(unauthorizedHtml, /Unlock Dashboard/);
    assert.equal(loginResponse.status, 302);
    assert.ok(cookie);
    assert.match(sessionToken ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(sessionToken, "top-secret");
    assert.equal(cookie?.includes("SameSite=Strict"), true);
    assert.equal(cookie?.includes("Secure"), false);
    assert.equal(response.status, 200);
    assert.match(html, /Vega Memory Dashboard/);
    assert.equal(response.headers.get("content-security-policy")?.includes("script-src 'self'"), true);
    assert.equal(apiResponse.status, 200);
    assert.equal(logoutResponse.status, 302);
    assert.equal(relockedResponse.status, 401);
    assert.equal(apiAfterLogout.status, 401);
  } finally {
    await server.stop();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Dashboard login adds Secure for non-localhost hosts", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-dashboard-secure-"));
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
    const body = new URLSearchParams({
      apiKey: "top-secret"
    }).toString();
    const cookie = await new Promise<string | undefined>((resolve, reject) => {
      const request = httpRequest(
        {
          headers: {
            "content-length": String(Buffer.byteLength(body)),
            "content-type": "application/x-www-form-urlencoded",
            host: "vega.example.com"
          },
          hostname: "127.0.0.1",
          method: "POST",
          path: "/dashboard/login",
          port
        },
        (response) => {
          response.resume();
          resolve(response.headers["set-cookie"]?.[0]);
        }
      );

      request.on("error", reject);
      request.end(body);
    });

    assert.ok(cookie);
    assert.equal(cookie?.includes("Secure"), true);
    assert.equal(cookie?.includes("SameSite=Strict"), true);
  } finally {
    await server.stop();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
