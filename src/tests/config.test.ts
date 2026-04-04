import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../config.js";

test("loadConfig returns the documented defaults", () => {
  const previous = {
    VEGA_DB_PATH: process.env.VEGA_DB_PATH,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    VEGA_TOKEN_BUDGET: process.env.VEGA_TOKEN_BUDGET,
    VEGA_SIMILARITY_THRESHOLD: process.env.VEGA_SIMILARITY_THRESHOLD,
    VEGA_BACKUP_RETENTION_DAYS: process.env.VEGA_BACKUP_RETENTION_DAYS,
    VEGA_API_PORT: process.env.VEGA_API_PORT,
    VEGA_API_KEY: process.env.VEGA_API_KEY,
    VEGA_MODE: process.env.VEGA_MODE,
    VEGA_SERVER_URL: process.env.VEGA_SERVER_URL,
    VEGA_CACHE_DB: process.env.VEGA_CACHE_DB,
    VEGA_TG_BOT_TOKEN: process.env.VEGA_TG_BOT_TOKEN,
    VEGA_TG_CHAT_ID: process.env.VEGA_TG_CHAT_ID,
    VEGA_ENCRYPTION_KEY: process.env.VEGA_ENCRYPTION_KEY,
    VEGA_CLOUD_BACKUP_DIR: process.env.VEGA_CLOUD_BACKUP_DIR
  };

  delete process.env.VEGA_DB_PATH;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.VEGA_TOKEN_BUDGET;
  delete process.env.VEGA_SIMILARITY_THRESHOLD;
  delete process.env.VEGA_BACKUP_RETENTION_DAYS;
  delete process.env.VEGA_API_PORT;
  delete process.env.VEGA_API_KEY;
  delete process.env.VEGA_MODE;
  delete process.env.VEGA_SERVER_URL;
  delete process.env.VEGA_CACHE_DB;
  delete process.env.VEGA_TG_BOT_TOKEN;
  delete process.env.VEGA_TG_CHAT_ID;
  delete process.env.VEGA_ENCRYPTION_KEY;
  delete process.env.VEGA_CLOUD_BACKUP_DIR;

  assert.deepEqual(loadConfig(), {
    dbPath: "./data/memory.db",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    backupRetentionDays: 7,
    apiPort: 3271,
    apiKey: undefined,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(homedir(), ".vega", "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    cloudBackup: undefined
  });

  Object.assign(process.env, previous);
});

test("loadConfig reads overrides from process.env", () => {
  const previous = {
    VEGA_DB_PATH: process.env.VEGA_DB_PATH,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    VEGA_TOKEN_BUDGET: process.env.VEGA_TOKEN_BUDGET,
    VEGA_SIMILARITY_THRESHOLD: process.env.VEGA_SIMILARITY_THRESHOLD,
    VEGA_BACKUP_RETENTION_DAYS: process.env.VEGA_BACKUP_RETENTION_DAYS,
    VEGA_API_PORT: process.env.VEGA_API_PORT,
    VEGA_API_KEY: process.env.VEGA_API_KEY,
    VEGA_MODE: process.env.VEGA_MODE,
    VEGA_SERVER_URL: process.env.VEGA_SERVER_URL,
    VEGA_CACHE_DB: process.env.VEGA_CACHE_DB,
    VEGA_TG_BOT_TOKEN: process.env.VEGA_TG_BOT_TOKEN,
    VEGA_TG_CHAT_ID: process.env.VEGA_TG_CHAT_ID,
    VEGA_ENCRYPTION_KEY: process.env.VEGA_ENCRYPTION_KEY,
    VEGA_CLOUD_BACKUP_DIR: process.env.VEGA_CLOUD_BACKUP_DIR
  };

  process.env.VEGA_DB_PATH = "/tmp/vega.db";
  process.env.OLLAMA_BASE_URL = "http://localhost:9999";
  process.env.OLLAMA_MODEL = "nomic-embed-text";
  process.env.VEGA_TOKEN_BUDGET = "4096";
  process.env.VEGA_SIMILARITY_THRESHOLD = "0.91";
  process.env.VEGA_BACKUP_RETENTION_DAYS = "14";
  process.env.VEGA_API_PORT = "4321";
  process.env.VEGA_API_KEY = "super-secret";
  process.env.VEGA_MODE = "client";
  process.env.VEGA_SERVER_URL = "http://127.0.0.1:3271";
  process.env.VEGA_CACHE_DB = "/tmp/vega-cache.db";
  process.env.VEGA_TG_BOT_TOKEN = "bot-token";
  process.env.VEGA_TG_CHAT_ID = "chat-id";
  process.env.VEGA_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.VEGA_CLOUD_BACKUP_DIR = "/tmp/vega-cloud";

  assert.deepEqual(loadConfig(), {
    dbPath: "/tmp/vega.db",
    ollamaBaseUrl: "http://localhost:9999",
    ollamaModel: "nomic-embed-text",
    tokenBudget: 4096,
    similarityThreshold: 0.91,
    backupRetentionDays: 14,
    apiPort: 4321,
    apiKey: "super-secret",
    mode: "client",
    serverUrl: "http://127.0.0.1:3271",
    cacheDbPath: "/tmp/vega-cache.db",
    telegramBotToken: "bot-token",
    telegramChatId: "chat-id",
    encryptionKey:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    cloudBackup: {
      enabled: true,
      provider: "local-sync",
      destDir: "/tmp/vega-cloud"
    }
  });

  Object.assign(process.env, previous);
});

test("loadConfig clamps invalid numeric values", () => {
  const previous = {
    VEGA_TOKEN_BUDGET: process.env.VEGA_TOKEN_BUDGET,
    VEGA_SIMILARITY_THRESHOLD: process.env.VEGA_SIMILARITY_THRESHOLD,
    VEGA_BACKUP_RETENTION_DAYS: process.env.VEGA_BACKUP_RETENTION_DAYS,
    VEGA_API_PORT: process.env.VEGA_API_PORT
  };

  process.env.VEGA_TOKEN_BUDGET = "100";
  process.env.VEGA_SIMILARITY_THRESHOLD = "1.5";
  process.env.VEGA_BACKUP_RETENTION_DAYS = "999";
  process.env.VEGA_API_PORT = "not-a-number";

  const config = loadConfig();

  assert.equal(config.tokenBudget, 500);
  assert.equal(config.similarityThreshold, 1);
  assert.equal(config.backupRetentionDays, 365);
  assert.equal(config.apiPort, 3271);

  Object.assign(process.env, previous);
});

test("loadConfig reads ~/.vega/config.json values and lets env override them", () => {
  const tempHome = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "vega-config-home-"));
  const previous = {
    HOME: process.env.HOME,
    VEGA_MODE: process.env.VEGA_MODE,
    VEGA_SERVER_URL: process.env.VEGA_SERVER_URL,
    VEGA_API_KEY: process.env.VEGA_API_KEY,
    VEGA_CACHE_DB: process.env.VEGA_CACHE_DB
  };

  try {
    mkdirSync(join(tempHome, ".vega"), { recursive: true });
    writeFileSync(
      join(tempHome, ".vega", "config.json"),
      `${JSON.stringify({
        mode: "client",
        server: "http://127.0.0.1:4321",
        api_key: "file-secret",
        cache_db: "~/.vega/file-cache.db"
      })}\n`,
      "utf8"
    );

    process.env.HOME = tempHome;
    delete process.env.VEGA_MODE;
    delete process.env.VEGA_SERVER_URL;
    delete process.env.VEGA_API_KEY;
    delete process.env.VEGA_CACHE_DB;

    const config = loadConfig();

    assert.equal(config.mode, "client");
    assert.equal(config.serverUrl, "http://127.0.0.1:4321");
    assert.equal(config.apiKey, "file-secret");
    assert.equal(config.cacheDbPath, join(tempHome, ".vega", "file-cache.db"));

    process.env.VEGA_API_KEY = "env-secret";

    assert.equal(loadConfig().apiKey, "env-secret");
  } finally {
    Object.assign(process.env, previous);
    rmSync(tempHome, { recursive: true, force: true });
  }
});
