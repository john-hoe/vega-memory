import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../config.js";

test("loadConfig returns the documented defaults", () => {
  const previous = {
    VEGA_DB_PATH: process.env.VEGA_DB_PATH,
    VEGA_EMBEDDING_PROVIDER: process.env.VEGA_EMBEDDING_PROVIDER,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    VEGA_OPENAI_API_KEY: process.env.VEGA_OPENAI_API_KEY,
    VEGA_OPENAI_BASE_URL: process.env.VEGA_OPENAI_BASE_URL,
    VEGA_OPENAI_EMBEDDING_MODEL: process.env.VEGA_OPENAI_EMBEDDING_MODEL,
    VEGA_TOKEN_BUDGET: process.env.VEGA_TOKEN_BUDGET,
    VEGA_SIMILARITY_THRESHOLD: process.env.VEGA_SIMILARITY_THRESHOLD,
    VEGA_SHARDING_ENABLED: process.env.VEGA_SHARDING_ENABLED,
    VEGA_BACKUP_RETENTION_DAYS: process.env.VEGA_BACKUP_RETENTION_DAYS,
    VEGA_OBSERVER_ENABLED: process.env.VEGA_OBSERVER_ENABLED,
    VEGA_API_PORT: process.env.VEGA_API_PORT,
    VEGA_API_KEY: process.env.VEGA_API_KEY,
    VEGA_MODE: process.env.VEGA_MODE,
    VEGA_SERVER_URL: process.env.VEGA_SERVER_URL,
    VEGA_CACHE_DB: process.env.VEGA_CACHE_DB,
    VEGA_TG_BOT_TOKEN: process.env.VEGA_TG_BOT_TOKEN,
    VEGA_TG_CHAT_ID: process.env.VEGA_TG_CHAT_ID,
    VEGA_OIDC_ISSUER_URL: process.env.VEGA_OIDC_ISSUER_URL,
    VEGA_OIDC_CLIENT_ID: process.env.VEGA_OIDC_CLIENT_ID,
    VEGA_OIDC_CLIENT_SECRET: process.env.VEGA_OIDC_CLIENT_SECRET,
    VEGA_OIDC_CALLBACK_URL: process.env.VEGA_OIDC_CALLBACK_URL,
    VEGA_DB_ENCRYPTION: process.env.VEGA_DB_ENCRYPTION,
    VEGA_ENCRYPTION_KEY: process.env.VEGA_ENCRYPTION_KEY,
    VEGA_CLOUD_BACKUP_DIR: process.env.VEGA_CLOUD_BACKUP_DIR
  };

  delete process.env.VEGA_DB_PATH;
  delete process.env.VEGA_EMBEDDING_PROVIDER;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.VEGA_OPENAI_API_KEY;
  delete process.env.VEGA_OPENAI_BASE_URL;
  delete process.env.VEGA_OPENAI_EMBEDDING_MODEL;
  delete process.env.VEGA_TOKEN_BUDGET;
  delete process.env.VEGA_SIMILARITY_THRESHOLD;
  delete process.env.VEGA_SHARDING_ENABLED;
  delete process.env.VEGA_BACKUP_RETENTION_DAYS;
  delete process.env.VEGA_OBSERVER_ENABLED;
  delete process.env.VEGA_API_PORT;
  delete process.env.VEGA_API_KEY;
  delete process.env.VEGA_MODE;
  delete process.env.VEGA_SERVER_URL;
  delete process.env.VEGA_CACHE_DB;
  delete process.env.VEGA_TG_BOT_TOKEN;
  delete process.env.VEGA_TG_CHAT_ID;
  delete process.env.VEGA_OIDC_ISSUER_URL;
  delete process.env.VEGA_OIDC_CLIENT_ID;
  delete process.env.VEGA_OIDC_CLIENT_SECRET;
  delete process.env.VEGA_OIDC_CALLBACK_URL;
  delete process.env.VEGA_DB_ENCRYPTION;
  delete process.env.VEGA_ENCRYPTION_KEY;
  delete process.env.VEGA_CLOUD_BACKUP_DIR;

  assert.deepEqual(loadConfig(), {
    dbPath: "./data/memory.db",
    embeddingProvider: "ollama",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "bge-m3",
    openaiApiKey: undefined,
    openaiBaseUrl: undefined,
    openaiEmbeddingModel: undefined,
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    shardingEnabled: false,
    backupRetentionDays: 7,
    apiPort: 3271,
    apiKey: undefined,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(homedir(), ".vega", "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    oidcIssuerUrl: undefined,
    oidcClientId: undefined,
    oidcClientSecret: undefined,
    oidcCallbackUrl: undefined,
    observerEnabled: false,
    dbEncryption: false,
    cloudBackup: undefined,
    customRedactionPatterns: []
  });

  Object.assign(process.env, previous);
});

test("loadConfig reads overrides from process.env", () => {
  const previous = {
    VEGA_DB_PATH: process.env.VEGA_DB_PATH,
    VEGA_EMBEDDING_PROVIDER: process.env.VEGA_EMBEDDING_PROVIDER,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    VEGA_OPENAI_API_KEY: process.env.VEGA_OPENAI_API_KEY,
    VEGA_OPENAI_BASE_URL: process.env.VEGA_OPENAI_BASE_URL,
    VEGA_OPENAI_EMBEDDING_MODEL: process.env.VEGA_OPENAI_EMBEDDING_MODEL,
    VEGA_TOKEN_BUDGET: process.env.VEGA_TOKEN_BUDGET,
    VEGA_SIMILARITY_THRESHOLD: process.env.VEGA_SIMILARITY_THRESHOLD,
    VEGA_SHARDING_ENABLED: process.env.VEGA_SHARDING_ENABLED,
    VEGA_BACKUP_RETENTION_DAYS: process.env.VEGA_BACKUP_RETENTION_DAYS,
    VEGA_OBSERVER_ENABLED: process.env.VEGA_OBSERVER_ENABLED,
    VEGA_API_PORT: process.env.VEGA_API_PORT,
    VEGA_API_KEY: process.env.VEGA_API_KEY,
    VEGA_MODE: process.env.VEGA_MODE,
    VEGA_SERVER_URL: process.env.VEGA_SERVER_URL,
    VEGA_CACHE_DB: process.env.VEGA_CACHE_DB,
    VEGA_TG_BOT_TOKEN: process.env.VEGA_TG_BOT_TOKEN,
    VEGA_TG_CHAT_ID: process.env.VEGA_TG_CHAT_ID,
    VEGA_OIDC_ISSUER_URL: process.env.VEGA_OIDC_ISSUER_URL,
    VEGA_OIDC_CLIENT_ID: process.env.VEGA_OIDC_CLIENT_ID,
    VEGA_OIDC_CLIENT_SECRET: process.env.VEGA_OIDC_CLIENT_SECRET,
    VEGA_OIDC_CALLBACK_URL: process.env.VEGA_OIDC_CALLBACK_URL,
    VEGA_DB_ENCRYPTION: process.env.VEGA_DB_ENCRYPTION,
    VEGA_ENCRYPTION_KEY: process.env.VEGA_ENCRYPTION_KEY,
    VEGA_CLOUD_BACKUP_DIR: process.env.VEGA_CLOUD_BACKUP_DIR
  };

  process.env.VEGA_DB_PATH = "/tmp/vega.db";
  process.env.VEGA_EMBEDDING_PROVIDER = "openai";
  process.env.OLLAMA_BASE_URL = "http://localhost:9999";
  process.env.OLLAMA_MODEL = "nomic-embed-text";
  process.env.VEGA_OPENAI_API_KEY = "openai-secret";
  process.env.VEGA_OPENAI_BASE_URL = "https://azure.example.com/openai/v1";
  process.env.VEGA_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.VEGA_TOKEN_BUDGET = "4096";
  process.env.VEGA_SIMILARITY_THRESHOLD = "0.91";
  process.env.VEGA_SHARDING_ENABLED = "true";
  process.env.VEGA_BACKUP_RETENTION_DAYS = "14";
  process.env.VEGA_OBSERVER_ENABLED = "true";
  process.env.VEGA_API_PORT = "4321";
  process.env.VEGA_API_KEY = "super-secret";
  process.env.VEGA_MODE = "client";
  process.env.VEGA_SERVER_URL = "http://127.0.0.1:3271";
  process.env.VEGA_CACHE_DB = "/tmp/vega-cache.db";
  process.env.VEGA_TG_BOT_TOKEN = "bot-token";
  process.env.VEGA_TG_CHAT_ID = "chat-id";
  process.env.VEGA_OIDC_ISSUER_URL = "https://issuer.example.com";
  process.env.VEGA_OIDC_CLIENT_ID = "vega-client";
  process.env.VEGA_OIDC_CLIENT_SECRET = "vega-secret";
  process.env.VEGA_OIDC_CALLBACK_URL = "http://127.0.0.1:3271/api/auth/oidc/callback";
  process.env.VEGA_DB_ENCRYPTION = "true";
  process.env.VEGA_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.VEGA_CLOUD_BACKUP_DIR = "/tmp/vega-cloud";

  assert.deepEqual(loadConfig(), {
    dbPath: "/tmp/vega.db",
    embeddingProvider: "openai",
    ollamaBaseUrl: "http://localhost:9999",
    ollamaModel: "nomic-embed-text",
    openaiApiKey: "openai-secret",
    openaiBaseUrl: "https://azure.example.com/openai/v1",
    openaiEmbeddingModel: "text-embedding-3-small",
    tokenBudget: 4096,
    similarityThreshold: 0.91,
    shardingEnabled: true,
    backupRetentionDays: 14,
    apiPort: 4321,
    apiKey: "super-secret",
    mode: "client",
    serverUrl: "http://127.0.0.1:3271",
    cacheDbPath: "/tmp/vega-cache.db",
    telegramBotToken: "bot-token",
    telegramChatId: "chat-id",
    oidcIssuerUrl: "https://issuer.example.com",
    oidcClientId: "vega-client",
    oidcClientSecret: "vega-secret",
    oidcCallbackUrl: "http://127.0.0.1:3271/api/auth/oidc/callback",
    observerEnabled: true,
    dbEncryption: true,
    encryptionKey:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    cloudBackup: {
      enabled: true,
      provider: "local-sync",
      destDir: "/tmp/vega-cloud"
    },
    customRedactionPatterns: []
  });

  Object.assign(process.env, previous);
});

test("loadConfig clamps invalid numeric values", () => {
  const previous = {
    VEGA_TOKEN_BUDGET: process.env.VEGA_TOKEN_BUDGET,
    VEGA_SIMILARITY_THRESHOLD: process.env.VEGA_SIMILARITY_THRESHOLD,
    VEGA_SHARDING_ENABLED: process.env.VEGA_SHARDING_ENABLED,
    VEGA_BACKUP_RETENTION_DAYS: process.env.VEGA_BACKUP_RETENTION_DAYS,
    VEGA_OBSERVER_ENABLED: process.env.VEGA_OBSERVER_ENABLED,
    VEGA_API_PORT: process.env.VEGA_API_PORT
  };

  process.env.VEGA_TOKEN_BUDGET = "100";
  process.env.VEGA_SIMILARITY_THRESHOLD = "1.5";
  process.env.VEGA_SHARDING_ENABLED = "not-a-bool";
  process.env.VEGA_BACKUP_RETENTION_DAYS = "999";
  process.env.VEGA_OBSERVER_ENABLED = "not-a-bool";
  process.env.VEGA_API_PORT = "not-a-number";

  const config = loadConfig();

  assert.equal(config.tokenBudget, 500);
  assert.equal(config.similarityThreshold, 1);
  assert.equal(config.shardingEnabled, false);
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
    VEGA_CACHE_DB: process.env.VEGA_CACHE_DB,
    VEGA_DB_ENCRYPTION: process.env.VEGA_DB_ENCRYPTION
  };

  try {
    mkdirSync(join(tempHome, ".vega"), { recursive: true });
    writeFileSync(
      join(tempHome, ".vega", "config.json"),
      `${JSON.stringify({
        mode: "client",
        server: "http://127.0.0.1:4321",
        api_key: "file-secret",
        cache_db: "~/.vega/file-cache.db",
        db_encryption: true,
        custom_redaction_patterns: [
          {
            name: "tenant secret",
            pattern: "tenant-secret-[a-z0-9]+",
            replacement: "[REDACTED:TENANT_SECRET]"
          }
        ]
      })}\n`,
      "utf8"
    );

    process.env.HOME = tempHome;
    delete process.env.VEGA_MODE;
    delete process.env.VEGA_SERVER_URL;
    delete process.env.VEGA_API_KEY;
    delete process.env.VEGA_CACHE_DB;
    delete process.env.VEGA_DB_ENCRYPTION;

    const config = loadConfig();

    assert.equal(config.mode, "client");
    assert.equal(config.serverUrl, "http://127.0.0.1:4321");
    assert.equal(config.apiKey, "file-secret");
    assert.equal(config.cacheDbPath, join(tempHome, ".vega", "file-cache.db"));
    assert.equal(config.dbEncryption, true);
    assert.deepEqual(config.customRedactionPatterns, [
      {
        name: "tenant secret",
        pattern: "tenant-secret-[a-z0-9]+",
        replacement: "[REDACTED:TENANT_SECRET]"
      }
    ]);

    process.env.VEGA_API_KEY = "env-secret";
    process.env.VEGA_DB_ENCRYPTION = "false";

    assert.equal(loadConfig().apiKey, "env-secret");
    assert.equal(loadConfig().dbEncryption, false);
  } finally {
    Object.assign(process.env, previous);
    rmSync(tempHome, { recursive: true, force: true });
  }
});
