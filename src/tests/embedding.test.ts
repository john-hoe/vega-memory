import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { cosineSimilarity, generateEmbedding, isOllamaAvailable } from "../embedding/ollama.js";

const unreachableConfig: VegaConfig = {
  dbPath: "./data/memory.db",
  ollamaBaseUrl: "http://localhost:99999",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
};

test("cosineSimilarity returns 1 for identical vectors", () => {
  const similarity = cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3]));

  assert.equal(similarity, 1);
});

test("cosineSimilarity returns 0 for orthogonal vectors", () => {
  const similarity = cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]));

  assert.equal(similarity, 0);
});

test("cosineSimilarity returns -1 for opposite vectors", () => {
  const similarity = cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]));

  assert.equal(similarity, -1);
});

test("cosineSimilarity returns 0 when either vector has zero magnitude", () => {
  const zeroSimilarity = cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 2]));
  const bothZeroSimilarity = cosineSimilarity(new Float32Array([0, 0]), new Float32Array([0, 0]));

  assert.equal(zeroSimilarity, 0);
  assert.equal(bothZeroSimilarity, 0);
});

test("generateEmbedding returns null when Ollama is unreachable", async () => {
  const embedding = await generateEmbedding("vega memory", unreachableConfig);

  assert.equal(embedding, null);
});

test("isOllamaAvailable returns false when Ollama is unreachable", async () => {
  const available = await isOllamaAvailable(unreachableConfig);

  assert.equal(available, false);
});
