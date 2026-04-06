import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { embeddingCache } from "../embedding/cache.js";
import { cosineSimilarity, generateEmbedding, isOllamaAvailable } from "../embedding/ollama.js";

const unreachableConfig: VegaConfig = {
  dbPath: "./data/memory.db",
  ollamaBaseUrl: "http://localhost:99999",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  dbEncryption: false,
};

const installFetchMock = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): (() => void) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
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

test("generateEmbedding scopes cache entries by normalized base URL and model", async () => {
  let calls = 0;
  const restoreFetch = installFetchMock((_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model: string;
    };

    return new Response(
      JSON.stringify({
        embeddings: [body.model === "model-a" ? [1, 0] : [0, 1]]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  });
  const configWithoutSlash: VegaConfig = {
    ...unreachableConfig,
    ollamaBaseUrl: "http://mock-ollama.local",
    ollamaModel: "model-a"
  };
  const configWithSlash: VegaConfig = {
    ...configWithoutSlash,
    ollamaBaseUrl: "http://mock-ollama.local/"
  };
  const configDifferentModel: VegaConfig = {
    ...configWithoutSlash,
    ollamaModel: "model-b"
  };

  embeddingCache.clear();

  try {
    const first = await generateEmbedding("shared text", configWithoutSlash);
    const second = await generateEmbedding("shared text", configWithSlash);
    const third = await generateEmbedding("shared text", configDifferentModel);

    assert.deepEqual(Array.from(first ?? []), [1, 0]);
    assert.deepEqual(Array.from(second ?? []), [1, 0]);
    assert.deepEqual(Array.from(third ?? []), [0, 1]);
    assert.equal(calls, 2);
  } finally {
    restoreFetch();
    embeddingCache.clear();
  }
});

test("isOllamaAvailable returns false when Ollama is unreachable", async () => {
  const available = await isOllamaAvailable(unreachableConfig);

  assert.equal(available, false);
});
