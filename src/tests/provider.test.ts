import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { AzureOpenAIChatProvider, AzureOpenAIEmbeddingProvider } from "../embedding/azure-openai-provider.js";
import { BedrockChatProvider, BedrockEmbeddingProvider } from "../embedding/bedrock-provider.js";
import { createChatProvider, createEmbeddingProvider } from "../embedding/factory.js";
import { generateEmbedding, chatWithOllama } from "../embedding/ollama.js";
import { OllamaChatProvider, OllamaEmbeddingProvider } from "../embedding/ollama-provider.js";
import { OpenAIChatProvider, OpenAIEmbeddingProvider } from "../embedding/openai-provider.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  dbEncryption: false,
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
  observerEnabled: false,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
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

test("factory returns Ollama providers by default", () => {
  const embeddingProvider = createEmbeddingProvider(baseConfig);
  const chatProvider = createChatProvider(baseConfig);

  assert.equal(embeddingProvider.name, "ollama");
  assert.equal(chatProvider.name, "ollama");
  assert.ok(embeddingProvider instanceof OllamaEmbeddingProvider);
  assert.ok(chatProvider instanceof OllamaChatProvider);
});

test("factory returns OpenAI providers when configured", () => {
  const config: VegaConfig = {
    ...baseConfig,
    embeddingProvider: "openai",
    openaiApiKey: "test-key"
  };
  const embeddingProvider = createEmbeddingProvider(config);
  const chatProvider = createChatProvider(config);

  assert.equal(embeddingProvider.name, "openai");
  assert.equal(chatProvider.name, "openai");
  assert.ok(embeddingProvider instanceof OpenAIEmbeddingProvider);
  assert.ok(chatProvider instanceof OpenAIChatProvider);
});

test("factory returns Azure OpenAI providers when configured", () => {
  const config: VegaConfig = {
    ...baseConfig,
    embeddingProvider: "azure-openai",
    azureOpenaiApiKey: "azure-key",
    azureOpenaiBaseUrl: "https://azure.example.com",
    azureOpenaiChatDeployment: "gpt-4o-mini",
    azureOpenaiEmbeddingDeployment: "text-embedding-3-small"
  };

  assert.ok(createEmbeddingProvider(config) instanceof AzureOpenAIEmbeddingProvider);
  assert.ok(createChatProvider(config) instanceof AzureOpenAIChatProvider);
});

test("factory returns Bedrock providers when configured", () => {
  const config: VegaConfig = {
    ...baseConfig,
    embeddingProvider: "bedrock",
    bedrockRegion: "us-east-1",
    bedrockChatModel: "anthropic.claude-3-5-sonnet",
    bedrockEmbeddingModel: "amazon.titan-embed-text-v2:0"
  };

  assert.ok(createEmbeddingProvider(config) instanceof BedrockEmbeddingProvider);
  assert.ok(createChatProvider(config) instanceof BedrockChatProvider);
});

test("OpenAIEmbeddingProvider uses configured base URL, API key, and embedding model", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new OpenAIEmbeddingProvider({
    ...baseConfig,
    openaiApiKey: "openai-test-key",
    openaiBaseUrl: "https://azure.example.com/openai/v1/",
    openaiEmbeddingModel: "text-embedding-3-large"
  });
  const restoreFetch = installFetchMock((url, init) => {
    requests.push({ url, init });

    return new Response(
      JSON.stringify({
        data: [
          {
            embedding: [0.25, 0.75]
          }
        ]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  });

  try {
    assert.deepEqual(await provider.generateEmbedding("provider test"), [0.25, 0.75]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://azure.example.com/openai/v1/embeddings");

    const headers = new Headers(requests[0]?.init?.headers);
    const body = JSON.parse(String(requests[0]?.init?.body ?? "{}")) as {
      input: string;
      model: string;
    };

    assert.equal(headers.get("authorization"), "Bearer openai-test-key");
    assert.equal(headers.get("api-key"), "openai-test-key");
    assert.deepEqual(body, {
      input: "provider test",
      model: "text-embedding-3-large"
    });
  } finally {
    restoreFetch();
  }
});

test("OpenAIChatProvider uses configured base URL and explicit chat model", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new OpenAIChatProvider({
    ...baseConfig,
    openaiApiKey: "openai-test-key",
    openaiBaseUrl: "https://azure.example.com/openai/v1",
    ollamaModel: "fallback-model"
  });
  const restoreFetch = installFetchMock((url, init) => {
    requests.push({ url, init });

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "openai reply"
            }
          }
        ]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  });

  try {
    assert.equal(
      await provider.chat([{ role: "user", content: "hello" }], { model: "gpt-4o-mini" }),
      "openai reply"
    );
    assert.equal(requests[0]?.url, "https://azure.example.com/openai/v1/chat/completions");

    const body = JSON.parse(String(requests[0]?.init?.body ?? "{}")) as {
      messages: Array<{ role: string; content: string }>;
      model: string;
    };

    assert.equal(body.model, "gpt-4o-mini");
    assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
  } finally {
    restoreFetch();
  }
});

test("AzureOpenAI providers hit deployment endpoints", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const restoreFetch = installFetchMock((url, init) => {
    requests.push({ url, init });

    return new Response(
      JSON.stringify(
        url.includes("/embeddings")
          ? { data: [{ embedding: [0.5, 0.25] }] }
          : { choices: [{ message: { content: "azure reply" } }] }
      ),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  });
  const config: VegaConfig = {
    ...baseConfig,
    azureOpenaiApiKey: "azure-key",
    azureOpenaiBaseUrl: "https://azure.example.com",
    azureOpenaiApiVersion: "2024-10-21",
    azureOpenaiChatDeployment: "chat-deployment",
    azureOpenaiEmbeddingDeployment: "embedding-deployment"
  };

  try {
    const embeddingProvider = new AzureOpenAIEmbeddingProvider(config);
    const chatProvider = new AzureOpenAIChatProvider(config);

    assert.deepEqual(await embeddingProvider.generateEmbedding("azure text"), [0.5, 0.25]);
    assert.equal(await chatProvider.chat([{ role: "user", content: "hello" }]), "azure reply");
    assert.match(requests[0]?.url ?? "", /deployments\/embedding-deployment\/embeddings/);
    assert.match(requests[1]?.url ?? "", /deployments\/chat-deployment\/chat\/completions/);
  } finally {
    restoreFetch();
  }
});

test("Bedrock providers use the injected client", async () => {
  const calls: string[] = [];
  const embeddingProvider = new BedrockEmbeddingProvider(
    {
      ...baseConfig,
      bedrockRegion: "us-east-1",
      bedrockEmbeddingModel: "amazon.titan-embed-text-v2:0",
      bedrockChatModel: "anthropic.claude-3-5-sonnet"
    },
    {
      async send(command: { constructor?: { name?: string } }): Promise<unknown> {
        calls.push(command.constructor?.name ?? "unknown");
        if (command.constructor?.name === "InvokeModelCommand") {
          return {
            body: Buffer.from(JSON.stringify({ embedding: [0.3, 0.7] }))
          };
        }

        return {
          output: {
            message: {
              content: [{ text: "bedrock reply" }]
            }
          }
        };
      }
    }
  );
  const chatProvider = new BedrockChatProvider(
    {
      ...baseConfig,
      bedrockRegion: "us-east-1",
      bedrockEmbeddingModel: "amazon.titan-embed-text-v2:0",
      bedrockChatModel: "anthropic.claude-3-5-sonnet"
    },
    {
      async send(command: { constructor?: { name?: string } }): Promise<unknown> {
        calls.push(command.constructor?.name ?? "unknown");
        if (command.constructor?.name === "InvokeModelCommand") {
          return {
            body: Buffer.from(JSON.stringify({ embedding: [0.3, 0.7] }))
          };
        }

        return {
          output: {
            message: {
              content: [{ text: "bedrock reply" }]
            }
          }
        };
      }
    }
  );

  assert.deepEqual(await embeddingProvider.generateEmbedding("bedrock text"), [0.3, 0.7]);
  assert.equal(await chatProvider.chat([{ role: "user", content: "hello" }]), "bedrock reply");
  assert.ok(calls.includes("InvokeModelCommand"));
  assert.ok(calls.includes("ConverseCommand"));
});

test("existing Ollama wrapper exports remain compatible with default provider selection", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const restoreFetch = installFetchMock((url, init) => {
    requests.push({ url, init });

    if (url.endsWith("/api/embed")) {
      return new Response(
        JSON.stringify({
          embeddings: [[1, 2, 3]]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return new Response(
      JSON.stringify({
        message: {
          content: "compatibility reply"
        }
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  });

  try {
    const embedding = await generateEmbedding("hello", baseConfig);
    const reply = await chatWithOllama([{ role: "user", content: "hello" }], baseConfig);

    assert.deepEqual(Array.from(embedding ?? []), [1, 2, 3]);
    assert.equal(reply, "compatibility reply");
    assert.equal(requests[0]?.url, "http://localhost:11434/api/embed");
    assert.equal(requests[1]?.url, "http://localhost:11434/api/chat");
  } finally {
    restoreFetch();
  }
});
