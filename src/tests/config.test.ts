import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../config.js";

const assertConfigSubset = (
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): void => {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value);
  }
};

test("loadConfig returns the documented defaults", () => {
  const previous = {
    VEGA_DB_PATH: process.env.VEGA_DB_PATH,
    VEGA_DATABASE_TYPE: process.env.VEGA_DATABASE_TYPE,
    VEGA_METRICS_ENABLED: process.env.VEGA_METRICS_ENABLED,
    VEGA_SENTRY_DSN: process.env.VEGA_SENTRY_DSN,
    VEGA_LOG_LEVEL: process.env.VEGA_LOG_LEVEL,
    VEGA_LOG_FORMAT: process.env.VEGA_LOG_FORMAT,
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
    VEGA_ARCHIVE_MAX_SIZE_MB: process.env.VEGA_ARCHIVE_MAX_SIZE_MB,
    VEGA_OBSERVER_ENABLED: process.env.VEGA_OBSERVER_ENABLED,
    VEGA_API_PORT: process.env.VEGA_API_PORT,
    VEGA_API_KEY: process.env.VEGA_API_KEY,
    VEGA_MODE: process.env.VEGA_MODE,
    VEGA_SERVER_URL: process.env.VEGA_SERVER_URL,
    VEGA_CACHE_DB: process.env.VEGA_CACHE_DB,
    VEGA_TG_BOT_TOKEN: process.env.VEGA_TG_BOT_TOKEN,
    VEGA_TG_CHAT_ID: process.env.VEGA_TG_CHAT_ID,
    VEGA_SLACK_WEBHOOK_URL: process.env.VEGA_SLACK_WEBHOOK_URL,
    VEGA_SLACK_BOT_TOKEN: process.env.VEGA_SLACK_BOT_TOKEN,
    VEGA_SLACK_CHANNEL: process.env.VEGA_SLACK_CHANNEL,
    VEGA_SLACK_ENABLED: process.env.VEGA_SLACK_ENABLED,
    VEGA_OPENCLAW_URL: process.env.VEGA_OPENCLAW_URL,
    VEGA_OPENCLAW_KEY: process.env.VEGA_OPENCLAW_KEY,
    VEGA_OPENCLAW_ENABLED: process.env.VEGA_OPENCLAW_ENABLED,
    VEGA_STRIPE_SECRET_KEY: process.env.VEGA_STRIPE_SECRET_KEY,
    VEGA_STRIPE_WEBHOOK_SECRET: process.env.VEGA_STRIPE_WEBHOOK_SECRET,
    VEGA_STRIPE_PUBLISHABLE_KEY: process.env.VEGA_STRIPE_PUBLISHABLE_KEY,
    VEGA_STRIPE_ENABLED: process.env.VEGA_STRIPE_ENABLED,
    VEGA_OIDC_ISSUER_URL: process.env.VEGA_OIDC_ISSUER_URL,
    VEGA_OIDC_CLIENT_ID: process.env.VEGA_OIDC_CLIENT_ID,
    VEGA_OIDC_CLIENT_SECRET: process.env.VEGA_OIDC_CLIENT_SECRET,
    VEGA_OIDC_CALLBACK_URL: process.env.VEGA_OIDC_CALLBACK_URL,
    VEGA_REDIS_URL: process.env.VEGA_REDIS_URL,
    VEGA_REDIS_HOST: process.env.VEGA_REDIS_HOST,
    VEGA_REDIS_PORT: process.env.VEGA_REDIS_PORT,
    VEGA_REDIS_PASSWORD: process.env.VEGA_REDIS_PASSWORD,
    VEGA_REDIS_DB: process.env.VEGA_REDIS_DB,
    VEGA_REDIS_ENABLED: process.env.VEGA_REDIS_ENABLED,
    VEGA_QUEUE_ENABLED: process.env.VEGA_QUEUE_ENABLED,
    VEGA_QUEUE_REDIS_URL: process.env.VEGA_QUEUE_REDIS_URL,
    VEGA_QUEUE_CONCURRENCY: process.env.VEGA_QUEUE_CONCURRENCY,
    VEGA_PG_HOST: process.env.VEGA_PG_HOST,
    VEGA_PG_PORT: process.env.VEGA_PG_PORT,
    VEGA_PG_DATABASE: process.env.VEGA_PG_DATABASE,
    VEGA_PG_USER: process.env.VEGA_PG_USER,
    VEGA_PG_PASSWORD: process.env.VEGA_PG_PASSWORD,
    VEGA_PG_SSL: process.env.VEGA_PG_SSL,
    VEGA_PG_SCHEMA: process.env.VEGA_PG_SCHEMA,
    VEGA_DB_ENCRYPTION: process.env.VEGA_DB_ENCRYPTION,
    VEGA_BYOK_ENABLED: process.env.VEGA_BYOK_ENABLED,
    VEGA_CSRF_ENABLED: process.env.VEGA_CSRF_ENABLED,
    VEGA_CORS_ORIGINS: process.env.VEGA_CORS_ORIGINS,
    VEGA_ENCRYPTION_KEY: process.env.VEGA_ENCRYPTION_KEY,
    VEGA_CLOUD_BACKUP_DIR: process.env.VEGA_CLOUD_BACKUP_DIR,
    VEGA_CLOUD_BACKUP_TYPE: process.env.VEGA_CLOUD_BACKUP_TYPE,
    VEGA_S3_BUCKET: process.env.VEGA_S3_BUCKET,
    VEGA_S3_REGION: process.env.VEGA_S3_REGION,
    VEGA_FEATURE_FACT_CLAIMS: process.env.VEGA_FEATURE_FACT_CLAIMS,
    VEGA_FEATURE_RAW_ARCHIVE: process.env.VEGA_FEATURE_RAW_ARCHIVE,
    VEGA_FEATURE_TOPIC_RECALL: process.env.VEGA_FEATURE_TOPIC_RECALL,
    VEGA_FEATURE_DEEP_RECALL: process.env.VEGA_FEATURE_DEEP_RECALL,
    VEGA_WEBHOOKS: process.env.VEGA_WEBHOOKS
  };

  delete process.env.VEGA_DB_PATH;
  delete process.env.VEGA_DATABASE_TYPE;
  delete process.env.VEGA_METRICS_ENABLED;
  delete process.env.VEGA_SENTRY_DSN;
  delete process.env.VEGA_LOG_LEVEL;
  delete process.env.VEGA_LOG_FORMAT;
  delete process.env.VEGA_EMBEDDING_PROVIDER;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.VEGA_OPENAI_API_KEY;
  delete process.env.VEGA_OPENAI_BASE_URL;
  delete process.env.VEGA_OPENAI_EMBEDDING_MODEL;
  delete process.env.VEGA_AZURE_OPENAI_API_KEY;
  delete process.env.VEGA_AZURE_OPENAI_BASE_URL;
  delete process.env.VEGA_AZURE_OPENAI_API_VERSION;
  delete process.env.VEGA_AZURE_OPENAI_CHAT_DEPLOYMENT;
  delete process.env.VEGA_AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
  delete process.env.VEGA_BEDROCK_REGION;
  delete process.env.VEGA_BEDROCK_CHAT_MODEL;
  delete process.env.VEGA_BEDROCK_EMBEDDING_MODEL;
  delete process.env.VEGA_TOKEN_BUDGET;
  delete process.env.VEGA_SIMILARITY_THRESHOLD;
  delete process.env.VEGA_SHARDING_ENABLED;
  delete process.env.VEGA_BACKUP_RETENTION_DAYS;
  delete process.env.VEGA_ARCHIVE_MAX_SIZE_MB;
  delete process.env.VEGA_OBSERVER_ENABLED;
  delete process.env.VEGA_API_PORT;
  delete process.env.VEGA_API_KEY;
  delete process.env.VEGA_MODE;
  delete process.env.VEGA_SERVER_URL;
  delete process.env.VEGA_CACHE_DB;
  delete process.env.VEGA_TG_BOT_TOKEN;
  delete process.env.VEGA_TG_CHAT_ID;
  delete process.env.VEGA_SLACK_WEBHOOK_URL;
  delete process.env.VEGA_SLACK_BOT_TOKEN;
  delete process.env.VEGA_SLACK_CHANNEL;
  delete process.env.VEGA_SLACK_ENABLED;
  delete process.env.VEGA_OPENCLAW_URL;
  delete process.env.VEGA_OPENCLAW_KEY;
  delete process.env.VEGA_OPENCLAW_ENABLED;
  delete process.env.VEGA_STRIPE_SECRET_KEY;
  delete process.env.VEGA_STRIPE_WEBHOOK_SECRET;
  delete process.env.VEGA_STRIPE_PUBLISHABLE_KEY;
  delete process.env.VEGA_STRIPE_ENABLED;
  delete process.env.VEGA_OIDC_ISSUER_URL;
  delete process.env.VEGA_OIDC_CLIENT_ID;
  delete process.env.VEGA_OIDC_CLIENT_SECRET;
  delete process.env.VEGA_OIDC_CALLBACK_URL;
  delete process.env.VEGA_REDIS_URL;
  delete process.env.VEGA_REDIS_HOST;
  delete process.env.VEGA_REDIS_PORT;
  delete process.env.VEGA_REDIS_PASSWORD;
  delete process.env.VEGA_REDIS_DB;
  delete process.env.VEGA_REDIS_ENABLED;
  delete process.env.VEGA_QUEUE_ENABLED;
  delete process.env.VEGA_QUEUE_REDIS_URL;
  delete process.env.VEGA_QUEUE_CONCURRENCY;
  delete process.env.VEGA_PG_HOST;
  delete process.env.VEGA_PG_PORT;
  delete process.env.VEGA_PG_DATABASE;
  delete process.env.VEGA_PG_USER;
  delete process.env.VEGA_PG_PASSWORD;
  delete process.env.VEGA_PG_SSL;
  delete process.env.VEGA_PG_SCHEMA;
  delete process.env.VEGA_DB_ENCRYPTION;
  delete process.env.VEGA_BYOK_ENABLED;
  delete process.env.VEGA_CSRF_ENABLED;
  delete process.env.VEGA_CORS_ORIGINS;
  delete process.env.VEGA_ENCRYPTION_KEY;
  delete process.env.VEGA_CLOUD_BACKUP_DIR;
  delete process.env.VEGA_CLOUD_BACKUP_TYPE;
  delete process.env.VEGA_S3_BUCKET;
  delete process.env.VEGA_S3_REGION;
  delete process.env.VEGA_FEATURE_FACT_CLAIMS;
  delete process.env.VEGA_FEATURE_RAW_ARCHIVE;
  delete process.env.VEGA_FEATURE_TOPIC_RECALL;
  delete process.env.VEGA_FEATURE_DEEP_RECALL;
  delete process.env.VEGA_WEBHOOKS;

  assertConfigSubset(loadConfig() as unknown as Record<string, unknown>, {
    dbPath: "./data/memory.db",
    databaseType: "sqlite",
    metricsEnabled: false,
    sentryDsn: undefined,
    logLevel: "info",
    logFormat: "json",
    embeddingProvider: "ollama",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "bge-m3",
    openaiApiKey: undefined,
    openaiBaseUrl: undefined,
    openaiEmbeddingModel: undefined,
    azureOpenaiApiKey: undefined,
    azureOpenaiBaseUrl: undefined,
    azureOpenaiApiVersion: undefined,
    azureOpenaiChatDeployment: undefined,
    azureOpenaiEmbeddingDeployment: undefined,
    bedrockRegion: undefined,
    bedrockChatModel: undefined,
    bedrockEmbeddingModel: undefined,
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    shardingEnabled: false,
    backupRetentionDays: 7,
    archiveMaxSizeMb: 500,
    apiPort: 3271,
    apiKey: undefined,
    mode: "server",
    serverUrl: undefined,
    cacheDbPath: join(homedir(), ".vega", "cache.db"),
    telegramBotToken: undefined,
    telegramChatId: undefined,
    slackWebhookUrl: undefined,
    slackBotToken: undefined,
    slackChannel: undefined,
    slackEnabled: false,
    openclawUrl: undefined,
    openclawKey: undefined,
    openclawEnabled: false,
    stripeSecretKey: undefined,
    stripeWebhookSecret: undefined,
    stripePublishableKey: undefined,
    stripeEnabled: false,
    oidcIssuerUrl: undefined,
    oidcClientId: undefined,
    oidcClientSecret: undefined,
    oidcCallbackUrl: undefined,
    redisUrl: undefined,
    redisHost: undefined,
    redisPort: undefined,
    redisPassword: undefined,
    redisDb: undefined,
    redisEnabled: false,
    queueEnabled: false,
    queueRedisUrl: undefined,
    queueConcurrency: 1,
    pgHost: undefined,
    pgPort: undefined,
    pgDatabase: undefined,
    pgUser: undefined,
    pgPassword: undefined,
    pgSsl: undefined,
    pgSchema: undefined,
    observerEnabled: false,
    dbEncryption: false,
    byokEnabled: false,
    csrfEnabled: false,
    corsOrigins: undefined,
    cloudBackup: undefined,
    features: {
      factClaims: false,
      rawArchive: true,
      topicRecall: false,
      deepRecall: true
    },
    customRedactionPatterns: []
  });

  Object.assign(process.env, previous);
});

test("loadConfig reads overrides from process.env", () => {
  const previous = {
    VEGA_DB_PATH: process.env.VEGA_DB_PATH,
    VEGA_DATABASE_TYPE: process.env.VEGA_DATABASE_TYPE,
    VEGA_METRICS_ENABLED: process.env.VEGA_METRICS_ENABLED,
    VEGA_SENTRY_DSN: process.env.VEGA_SENTRY_DSN,
    VEGA_LOG_LEVEL: process.env.VEGA_LOG_LEVEL,
    VEGA_LOG_FORMAT: process.env.VEGA_LOG_FORMAT,
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
    VEGA_ARCHIVE_MAX_SIZE_MB: process.env.VEGA_ARCHIVE_MAX_SIZE_MB,
    VEGA_OBSERVER_ENABLED: process.env.VEGA_OBSERVER_ENABLED,
    VEGA_API_PORT: process.env.VEGA_API_PORT,
    VEGA_API_KEY: process.env.VEGA_API_KEY,
    VEGA_MODE: process.env.VEGA_MODE,
    VEGA_SERVER_URL: process.env.VEGA_SERVER_URL,
    VEGA_CACHE_DB: process.env.VEGA_CACHE_DB,
    VEGA_TG_BOT_TOKEN: process.env.VEGA_TG_BOT_TOKEN,
    VEGA_TG_CHAT_ID: process.env.VEGA_TG_CHAT_ID,
    VEGA_SLACK_WEBHOOK_URL: process.env.VEGA_SLACK_WEBHOOK_URL,
    VEGA_SLACK_BOT_TOKEN: process.env.VEGA_SLACK_BOT_TOKEN,
    VEGA_SLACK_CHANNEL: process.env.VEGA_SLACK_CHANNEL,
    VEGA_SLACK_ENABLED: process.env.VEGA_SLACK_ENABLED,
    VEGA_OPENCLAW_URL: process.env.VEGA_OPENCLAW_URL,
    VEGA_OPENCLAW_KEY: process.env.VEGA_OPENCLAW_KEY,
    VEGA_OPENCLAW_ENABLED: process.env.VEGA_OPENCLAW_ENABLED,
    VEGA_STRIPE_SECRET_KEY: process.env.VEGA_STRIPE_SECRET_KEY,
    VEGA_STRIPE_WEBHOOK_SECRET: process.env.VEGA_STRIPE_WEBHOOK_SECRET,
    VEGA_STRIPE_PUBLISHABLE_KEY: process.env.VEGA_STRIPE_PUBLISHABLE_KEY,
    VEGA_STRIPE_ENABLED: process.env.VEGA_STRIPE_ENABLED,
    VEGA_OIDC_ISSUER_URL: process.env.VEGA_OIDC_ISSUER_URL,
    VEGA_OIDC_CLIENT_ID: process.env.VEGA_OIDC_CLIENT_ID,
    VEGA_OIDC_CLIENT_SECRET: process.env.VEGA_OIDC_CLIENT_SECRET,
    VEGA_OIDC_CALLBACK_URL: process.env.VEGA_OIDC_CALLBACK_URL,
    VEGA_REDIS_URL: process.env.VEGA_REDIS_URL,
    VEGA_REDIS_HOST: process.env.VEGA_REDIS_HOST,
    VEGA_REDIS_PORT: process.env.VEGA_REDIS_PORT,
    VEGA_REDIS_PASSWORD: process.env.VEGA_REDIS_PASSWORD,
    VEGA_REDIS_DB: process.env.VEGA_REDIS_DB,
    VEGA_REDIS_ENABLED: process.env.VEGA_REDIS_ENABLED,
    VEGA_QUEUE_ENABLED: process.env.VEGA_QUEUE_ENABLED,
    VEGA_QUEUE_REDIS_URL: process.env.VEGA_QUEUE_REDIS_URL,
    VEGA_QUEUE_CONCURRENCY: process.env.VEGA_QUEUE_CONCURRENCY,
    VEGA_PG_HOST: process.env.VEGA_PG_HOST,
    VEGA_PG_PORT: process.env.VEGA_PG_PORT,
    VEGA_PG_DATABASE: process.env.VEGA_PG_DATABASE,
    VEGA_PG_USER: process.env.VEGA_PG_USER,
    VEGA_PG_PASSWORD: process.env.VEGA_PG_PASSWORD,
    VEGA_PG_SSL: process.env.VEGA_PG_SSL,
    VEGA_PG_SCHEMA: process.env.VEGA_PG_SCHEMA,
    VEGA_DB_ENCRYPTION: process.env.VEGA_DB_ENCRYPTION,
    VEGA_BYOK_ENABLED: process.env.VEGA_BYOK_ENABLED,
    VEGA_CSRF_ENABLED: process.env.VEGA_CSRF_ENABLED,
    VEGA_CORS_ORIGINS: process.env.VEGA_CORS_ORIGINS,
    VEGA_ENCRYPTION_KEY: process.env.VEGA_ENCRYPTION_KEY,
    VEGA_CLOUD_BACKUP_DIR: process.env.VEGA_CLOUD_BACKUP_DIR,
    VEGA_CLOUD_BACKUP_TYPE: process.env.VEGA_CLOUD_BACKUP_TYPE,
    VEGA_S3_BUCKET: process.env.VEGA_S3_BUCKET,
    VEGA_S3_REGION: process.env.VEGA_S3_REGION,
    VEGA_FEATURE_FACT_CLAIMS: process.env.VEGA_FEATURE_FACT_CLAIMS,
    VEGA_FEATURE_RAW_ARCHIVE: process.env.VEGA_FEATURE_RAW_ARCHIVE,
    VEGA_FEATURE_TOPIC_RECALL: process.env.VEGA_FEATURE_TOPIC_RECALL,
    VEGA_FEATURE_DEEP_RECALL: process.env.VEGA_FEATURE_DEEP_RECALL,
    VEGA_WEBHOOKS: process.env.VEGA_WEBHOOKS
  };

  process.env.VEGA_DB_PATH = "/tmp/vega.db";
  process.env.VEGA_DATABASE_TYPE = "postgres";
  process.env.VEGA_METRICS_ENABLED = "true";
  process.env.VEGA_SENTRY_DSN = "https://example@sentry.test/1";
  process.env.VEGA_LOG_LEVEL = "debug";
  process.env.VEGA_LOG_FORMAT = "text";
  process.env.VEGA_EMBEDDING_PROVIDER = "openai";
  process.env.OLLAMA_BASE_URL = "http://localhost:9999";
  process.env.OLLAMA_MODEL = "nomic-embed-text";
  process.env.VEGA_OPENAI_API_KEY = "openai-secret";
  process.env.VEGA_OPENAI_BASE_URL = "https://azure.example.com/openai/v1";
  process.env.VEGA_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.VEGA_AZURE_OPENAI_API_KEY = "azure-secret";
  process.env.VEGA_AZURE_OPENAI_BASE_URL = "https://azure-openai.example";
  process.env.VEGA_AZURE_OPENAI_API_VERSION = "2024-10-21";
  process.env.VEGA_AZURE_OPENAI_CHAT_DEPLOYMENT = "gpt-4o-mini";
  process.env.VEGA_AZURE_OPENAI_EMBEDDING_DEPLOYMENT = "text-embedding";
  process.env.VEGA_BEDROCK_REGION = "us-east-1";
  process.env.VEGA_BEDROCK_CHAT_MODEL = "anthropic.claude-3-5-sonnet";
  process.env.VEGA_BEDROCK_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";
  process.env.VEGA_TOKEN_BUDGET = "4096";
  process.env.VEGA_SIMILARITY_THRESHOLD = "0.91";
  process.env.VEGA_SHARDING_ENABLED = "true";
  process.env.VEGA_BACKUP_RETENTION_DAYS = "14";
  process.env.VEGA_ARCHIVE_MAX_SIZE_MB = "750";
  process.env.VEGA_OBSERVER_ENABLED = "true";
  process.env.VEGA_API_PORT = "4321";
  process.env.VEGA_API_KEY = "super-secret";
  process.env.VEGA_MODE = "client";
  process.env.VEGA_SERVER_URL = "http://127.0.0.1:3271";
  process.env.VEGA_CACHE_DB = "/tmp/vega-cache.db";
  process.env.VEGA_TG_BOT_TOKEN = "bot-token";
  process.env.VEGA_TG_CHAT_ID = "chat-id";
  process.env.VEGA_SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/T000/B000/XXX";
  process.env.VEGA_SLACK_BOT_TOKEN = "xoxb-test-token";
  process.env.VEGA_SLACK_CHANNEL = "#vega-alerts";
  process.env.VEGA_SLACK_ENABLED = "true";
  process.env.VEGA_OPENCLAW_URL = "https://openclaw.example/api";
  process.env.VEGA_OPENCLAW_KEY = "openclaw-secret";
  process.env.VEGA_OPENCLAW_ENABLED = "true";
  process.env.VEGA_STRIPE_SECRET_KEY = "sk_test_123";
  process.env.VEGA_STRIPE_WEBHOOK_SECRET = "whsec_123";
  process.env.VEGA_STRIPE_PUBLISHABLE_KEY = "pk_test_123";
  process.env.VEGA_STRIPE_ENABLED = "true";
  process.env.VEGA_OIDC_ISSUER_URL = "https://issuer.example.com";
  process.env.VEGA_OIDC_CLIENT_ID = "vega-client";
  process.env.VEGA_OIDC_CLIENT_SECRET = "vega-secret";
  process.env.VEGA_OIDC_CALLBACK_URL = "http://127.0.0.1:3271/api/auth/oidc/callback";
  process.env.VEGA_REDIS_URL = "redis://127.0.0.1:6379/2";
  process.env.VEGA_REDIS_HOST = "redis.internal";
  process.env.VEGA_REDIS_PORT = "6380";
  process.env.VEGA_REDIS_PASSWORD = "redis-secret";
  process.env.VEGA_REDIS_DB = "3";
  process.env.VEGA_REDIS_ENABLED = "true";
  process.env.VEGA_QUEUE_ENABLED = "true";
  process.env.VEGA_QUEUE_REDIS_URL = "redis://127.0.0.1:6379/9";
  process.env.VEGA_QUEUE_CONCURRENCY = "6";
  process.env.VEGA_PG_HOST = "db.internal";
  process.env.VEGA_PG_PORT = "5433";
  process.env.VEGA_PG_DATABASE = "vega_prod";
  process.env.VEGA_PG_USER = "vega_user";
  process.env.VEGA_PG_PASSWORD = "pg-secret";
  process.env.VEGA_PG_SSL = "true";
  process.env.VEGA_PG_SCHEMA = "memory";
  process.env.VEGA_DB_ENCRYPTION = "true";
  process.env.VEGA_BYOK_ENABLED = "true";
  process.env.VEGA_CSRF_ENABLED = "true";
  process.env.VEGA_CORS_ORIGINS = "https://app.example.com, https://admin.example.com";
  process.env.VEGA_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.VEGA_CLOUD_BACKUP_DIR = "/tmp/vega-cloud";
  delete process.env.VEGA_CLOUD_BACKUP_TYPE;
  delete process.env.VEGA_S3_BUCKET;
  delete process.env.VEGA_S3_REGION;
  process.env.VEGA_FEATURE_FACT_CLAIMS = "true";
  process.env.VEGA_FEATURE_RAW_ARCHIVE = "false";
  process.env.VEGA_FEATURE_TOPIC_RECALL = "yes";
  process.env.VEGA_FEATURE_DEEP_RECALL = "off";
  process.env.VEGA_WEBHOOKS = JSON.stringify([
    {
      url: "https://example.com/hooks/memory",
      secret: "top-secret",
      events: ["memory.created", "memory.updated"],
      enabled: true
    }
  ]);

  assertConfigSubset(loadConfig() as unknown as Record<string, unknown>, {
    dbPath: "/tmp/vega.db",
    databaseType: "postgres",
    metricsEnabled: true,
    sentryDsn: "https://example@sentry.test/1",
    logLevel: "debug",
    logFormat: "text",
    embeddingProvider: "openai",
    ollamaBaseUrl: "http://localhost:9999",
    ollamaModel: "nomic-embed-text",
    openaiApiKey: "openai-secret",
    openaiBaseUrl: "https://azure.example.com/openai/v1",
    openaiEmbeddingModel: "text-embedding-3-small",
    azureOpenaiApiKey: "azure-secret",
    azureOpenaiBaseUrl: "https://azure-openai.example",
    azureOpenaiApiVersion: "2024-10-21",
    azureOpenaiChatDeployment: "gpt-4o-mini",
    azureOpenaiEmbeddingDeployment: "text-embedding",
    bedrockRegion: "us-east-1",
    bedrockChatModel: "anthropic.claude-3-5-sonnet",
    bedrockEmbeddingModel: "amazon.titan-embed-text-v2:0",
    tokenBudget: 4096,
    similarityThreshold: 0.91,
    shardingEnabled: true,
    backupRetentionDays: 14,
    archiveMaxSizeMb: 750,
    apiPort: 4321,
    apiKey: "super-secret",
    mode: "client",
    serverUrl: "http://127.0.0.1:3271",
    cacheDbPath: "/tmp/vega-cache.db",
    telegramBotToken: "bot-token",
    telegramChatId: "chat-id",
    slackWebhookUrl: "https://hooks.slack.test/services/T000/B000/XXX",
    slackBotToken: "xoxb-test-token",
    slackChannel: "#vega-alerts",
    slackEnabled: true,
    openclawUrl: "https://openclaw.example/api",
    openclawKey: "openclaw-secret",
    openclawEnabled: true,
    stripeSecretKey: "sk_test_123",
    stripeWebhookSecret: "whsec_123",
    stripePublishableKey: "pk_test_123",
    stripeEnabled: true,
    oidcIssuerUrl: "https://issuer.example.com",
    oidcClientId: "vega-client",
    oidcClientSecret: "vega-secret",
    oidcCallbackUrl: "http://127.0.0.1:3271/api/auth/oidc/callback",
    redisUrl: "redis://127.0.0.1:6379/2",
    redisHost: "redis.internal",
    redisPort: 6380,
    redisPassword: "redis-secret",
    redisDb: 3,
    redisEnabled: true,
    queueEnabled: true,
    queueRedisUrl: "redis://127.0.0.1:6379/9",
    queueConcurrency: 6,
    pgHost: "db.internal",
    pgPort: 5433,
    pgDatabase: "vega_prod",
    pgUser: "vega_user",
    pgPassword: "pg-secret",
    pgSsl: true,
    pgSchema: "memory",
    observerEnabled: true,
    dbEncryption: true,
    byokEnabled: true,
    csrfEnabled: true,
    corsOrigins: ["https://app.example.com", "https://admin.example.com"],
    encryptionKey:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    cloudBackup: {
      enabled: true,
      provider: "local-sync",
      destDir: "/tmp/vega-cloud"
    },
    features: {
      factClaims: true,
      rawArchive: false,
      topicRecall: true,
      deepRecall: false
    },
    customRedactionPatterns: [],
    webhooks: [
      {
        url: "https://example.com/hooks/memory",
        secret: "top-secret",
        events: ["memory.created", "memory.updated"],
        enabled: true
      }
    ]
  });

  Object.assign(process.env, previous);
});

test("loadConfig reads webhook configs from VEGA_WEBHOOKS", () => {
  const previous = {
    VEGA_WEBHOOKS: process.env.VEGA_WEBHOOKS
  };

  try {
    process.env.VEGA_WEBHOOKS = JSON.stringify([
      {
        url: "https://jira.example/webhook",
        events: ["memory.created"],
        enabled: true
      },
      {
        url: "https://github.example/webhook",
        secret: "shared-secret",
        events: ["memory.updated", "memory.deleted"],
        enabled: false
      }
    ]);

    assert.deepEqual(loadConfig().webhooks, [
      {
        url: "https://jira.example/webhook",
        events: ["memory.created"],
        enabled: true
      },
      {
        url: "https://github.example/webhook",
        secret: "shared-secret",
        events: ["memory.updated", "memory.deleted"],
        enabled: false
      }
    ]);
  } finally {
    Object.assign(process.env, previous);
  }
});

test("loadConfig clamps invalid numeric values", () => {
  const previous = {
    VEGA_TOKEN_BUDGET: process.env.VEGA_TOKEN_BUDGET,
    VEGA_SIMILARITY_THRESHOLD: process.env.VEGA_SIMILARITY_THRESHOLD,
    VEGA_SHARDING_ENABLED: process.env.VEGA_SHARDING_ENABLED,
    VEGA_BACKUP_RETENTION_DAYS: process.env.VEGA_BACKUP_RETENTION_DAYS,
    VEGA_OBSERVER_ENABLED: process.env.VEGA_OBSERVER_ENABLED,
    VEGA_API_PORT: process.env.VEGA_API_PORT,
    VEGA_BYOK_ENABLED: process.env.VEGA_BYOK_ENABLED,
    VEGA_CSRF_ENABLED: process.env.VEGA_CSRF_ENABLED,
    VEGA_CORS_ORIGINS: process.env.VEGA_CORS_ORIGINS
  };

  process.env.VEGA_TOKEN_BUDGET = "100";
  process.env.VEGA_SIMILARITY_THRESHOLD = "1.5";
  process.env.VEGA_SHARDING_ENABLED = "not-a-bool";
  process.env.VEGA_BACKUP_RETENTION_DAYS = "999";
  process.env.VEGA_OBSERVER_ENABLED = "not-a-bool";
  process.env.VEGA_API_PORT = "not-a-number";
  process.env.VEGA_BYOK_ENABLED = "not-a-bool";
  process.env.VEGA_CSRF_ENABLED = "not-a-bool";
  process.env.VEGA_CORS_ORIGINS = " , ";

  const config = loadConfig();

  assert.equal(config.tokenBudget, 500);
  assert.equal(config.similarityThreshold, 1);
  assert.equal(config.shardingEnabled, false);
  assert.equal(config.backupRetentionDays, 365);
  assert.equal(config.apiPort, 3271);
  assert.equal(config.byokEnabled, false);
  assert.equal(config.csrfEnabled, false);
  assert.equal(config.corsOrigins, undefined);

  Object.assign(process.env, previous);
});

test("loadConfig reads s3 cloud backup env", () => {
  const previous = {
    VEGA_CLOUD_BACKUP_DIR: process.env.VEGA_CLOUD_BACKUP_DIR,
    VEGA_CLOUD_BACKUP_TYPE: process.env.VEGA_CLOUD_BACKUP_TYPE,
    VEGA_S3_BUCKET: process.env.VEGA_S3_BUCKET,
    VEGA_S3_REGION: process.env.VEGA_S3_REGION
  };

  try {
    delete process.env.VEGA_CLOUD_BACKUP_DIR;
    process.env.VEGA_CLOUD_BACKUP_TYPE = "s3";
    process.env.VEGA_S3_BUCKET = "vega-backups";
    process.env.VEGA_S3_REGION = "us-east-1";

    assert.deepEqual(loadConfig().cloudBackup, {
      enabled: true,
      provider: "s3",
      bucket: "vega-backups",
      region: "us-east-1",
      accessKeyId: undefined,
      secretAccessKey: undefined
    });
  } finally {
    Object.assign(process.env, previous);
  }
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

test("loadConfig includes regression guard defaults", () => {
  const previous = {
    VEGA_REGRESSION_MAX_SESSION_START_TOKEN: process.env.VEGA_REGRESSION_MAX_SESSION_START_TOKEN,
    VEGA_REGRESSION_MAX_RECALL_LATENCY_MS: process.env.VEGA_REGRESSION_MAX_RECALL_LATENCY_MS,
    VEGA_REGRESSION_MIN_RECALL_AVG_SIMILARITY: process.env.VEGA_REGRESSION_MIN_RECALL_AVG_SIMILARITY,
    VEGA_REGRESSION_MAX_TOP_K_INFLATION_RATIO: process.env.VEGA_REGRESSION_MAX_TOP_K_INFLATION_RATIO
  };

  try {
    delete process.env.VEGA_REGRESSION_MAX_SESSION_START_TOKEN;
    delete process.env.VEGA_REGRESSION_MAX_RECALL_LATENCY_MS;
    delete process.env.VEGA_REGRESSION_MIN_RECALL_AVG_SIMILARITY;
    delete process.env.VEGA_REGRESSION_MAX_TOP_K_INFLATION_RATIO;

    assert.deepEqual(loadConfig().regressionGuard, {
      maxSessionStartToken: 2500,
      maxRecallLatencyMs: 500,
      minRecallAvgSimilarity: 0.4,
      maxTopKInflationRatio: 0.3
    });
  } finally {
    Object.assign(process.env, previous);
  }
});

test("loadConfig reads regression guard overrides from process.env", () => {
  const previous = {
    VEGA_REGRESSION_MAX_SESSION_START_TOKEN: process.env.VEGA_REGRESSION_MAX_SESSION_START_TOKEN,
    VEGA_REGRESSION_MAX_RECALL_LATENCY_MS: process.env.VEGA_REGRESSION_MAX_RECALL_LATENCY_MS,
    VEGA_REGRESSION_MIN_RECALL_AVG_SIMILARITY: process.env.VEGA_REGRESSION_MIN_RECALL_AVG_SIMILARITY,
    VEGA_REGRESSION_MAX_TOP_K_INFLATION_RATIO: process.env.VEGA_REGRESSION_MAX_TOP_K_INFLATION_RATIO
  };

  try {
    process.env.VEGA_REGRESSION_MAX_SESSION_START_TOKEN = "3200";
    process.env.VEGA_REGRESSION_MAX_RECALL_LATENCY_MS = "750";
    process.env.VEGA_REGRESSION_MIN_RECALL_AVG_SIMILARITY = "0.55";
    process.env.VEGA_REGRESSION_MAX_TOP_K_INFLATION_RATIO = "0.2";

    assert.deepEqual(loadConfig().regressionGuard, {
      maxSessionStartToken: 3200,
      maxRecallLatencyMs: 750,
      minRecallAvgSimilarity: 0.55,
      maxTopKInflationRatio: 0.2
    });
  } finally {
    Object.assign(process.env, previous);
  }
});
