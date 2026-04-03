import assert from "node:assert/strict";
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
    VEGA_TG_BOT_TOKEN: process.env.VEGA_TG_BOT_TOKEN,
    VEGA_TG_CHAT_ID: process.env.VEGA_TG_CHAT_ID
  };

  delete process.env.VEGA_DB_PATH;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.VEGA_TOKEN_BUDGET;
  delete process.env.VEGA_SIMILARITY_THRESHOLD;
  delete process.env.VEGA_BACKUP_RETENTION_DAYS;
  delete process.env.VEGA_TG_BOT_TOKEN;
  delete process.env.VEGA_TG_CHAT_ID;

  assert.deepEqual(loadConfig(), {
    dbPath: "./data/memory.db",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "bge-m3",
    tokenBudget: 2000,
    similarityThreshold: 0.85,
    backupRetentionDays: 7
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
    VEGA_TG_BOT_TOKEN: process.env.VEGA_TG_BOT_TOKEN,
    VEGA_TG_CHAT_ID: process.env.VEGA_TG_CHAT_ID
  };

  process.env.VEGA_DB_PATH = "/tmp/vega.db";
  process.env.OLLAMA_BASE_URL = "http://localhost:9999";
  process.env.OLLAMA_MODEL = "nomic-embed-text";
  process.env.VEGA_TOKEN_BUDGET = "4096";
  process.env.VEGA_SIMILARITY_THRESHOLD = "0.91";
  process.env.VEGA_BACKUP_RETENTION_DAYS = "14";
  process.env.VEGA_TG_BOT_TOKEN = "bot-token";
  process.env.VEGA_TG_CHAT_ID = "chat-id";

  assert.deepEqual(loadConfig(), {
    dbPath: "/tmp/vega.db",
    ollamaBaseUrl: "http://localhost:9999",
    ollamaModel: "nomic-embed-text",
    tokenBudget: 4096,
    similarityThreshold: 0.91,
    backupRetentionDays: 14
  });

  Object.assign(process.env, previous);
});

test("loadConfig clamps invalid numeric values", () => {
  const previous = {
    VEGA_TOKEN_BUDGET: process.env.VEGA_TOKEN_BUDGET,
    VEGA_SIMILARITY_THRESHOLD: process.env.VEGA_SIMILARITY_THRESHOLD,
    VEGA_BACKUP_RETENTION_DAYS: process.env.VEGA_BACKUP_RETENTION_DAYS
  };

  process.env.VEGA_TOKEN_BUDGET = "100";
  process.env.VEGA_SIMILARITY_THRESHOLD = "1.5";
  process.env.VEGA_BACKUP_RETENTION_DAYS = "999";

  const config = loadConfig();

  assert.equal(config.tokenBudget, 500);
  assert.equal(config.similarityThreshold, 1);
  assert.equal(config.backupRetentionDays, 365);

  Object.assign(process.env, previous);
});
