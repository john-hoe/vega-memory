import type { VegaConfig } from "../config.js";
import { embeddingCache } from "./cache.js";
import type { ChatProvider, EmbeddingProvider } from "./provider.js";

type AzureConfig = Pick<
  VegaConfig,
  | "azureOpenaiApiKey"
  | "azureOpenaiBaseUrl"
  | "azureOpenaiApiVersion"
  | "azureOpenaiChatDeployment"
  | "azureOpenaiEmbeddingDeployment"
>;

const DEFAULT_API_VERSION = "2024-10-21";

const normalizeBaseUrl = (value: string | undefined): string => (value ?? "").replace(/\/+$/, "");

const fetchWithTimeout = async (
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
};

const buildHeaders = (apiKey: string | undefined): HeadersInit | null =>
  apiKey
    ? {
        "content-type": "application/json",
        "api-key": apiKey
      }
    : null;

export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "azure-openai";

  constructor(private readonly config: AzureConfig) {}

  async generateEmbedding(text: string): Promise<number[] | null> {
    const headers = buildHeaders(this.config.azureOpenaiApiKey);
    const deployment = this.config.azureOpenaiEmbeddingDeployment;
    if (!headers || !deployment || !this.config.azureOpenaiBaseUrl) {
      return null;
    }

    const cacheNamespace = `${normalizeBaseUrl(this.config.azureOpenaiBaseUrl)}\u0000${deployment}`;
    const cached = embeddingCache.get(text, cacheNamespace);
    if (cached !== undefined) {
      return Array.from(cached);
    }

    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(this.config.azureOpenaiBaseUrl)}/openai/deployments/${deployment}/embeddings?api-version=${this.config.azureOpenaiApiVersion ?? DEFAULT_API_VERSION}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ input: text })
      },
      10_000
    ).catch(() => null);

    if (!response || !response.ok) {
      return null;
    }

    const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = body.data?.[0]?.embedding;
    if (Array.isArray(embedding) && embedding.every((value) => typeof value === "number")) {
      embeddingCache.set(text, new Float32Array(embedding), cacheNamespace);
      return embedding;
    }

    return null;
  }

  async isAvailable(): Promise<boolean> {
    const headers = buildHeaders(this.config.azureOpenaiApiKey);
    if (!headers || !this.config.azureOpenaiBaseUrl) {
      return false;
    }

    try {
      const response = await fetchWithTimeout(
        `${normalizeBaseUrl(this.config.azureOpenaiBaseUrl)}/openai/models?api-version=${this.config.azureOpenaiApiVersion ?? DEFAULT_API_VERSION}`,
        { method: "GET", headers },
        3_000
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}

export class AzureOpenAIChatProvider implements ChatProvider {
  readonly name = "azure-openai";

  constructor(private readonly config: AzureConfig) {}

  async chat(messages: { role: string; content: string }[]): Promise<string | null> {
    const headers = buildHeaders(this.config.azureOpenaiApiKey);
    const deployment = this.config.azureOpenaiChatDeployment;
    if (!headers || !deployment || !this.config.azureOpenaiBaseUrl) {
      return null;
    }

    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(this.config.azureOpenaiBaseUrl)}/openai/deployments/${deployment}/chat/completions?api-version=${this.config.azureOpenaiApiVersion ?? DEFAULT_API_VERSION}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ messages })
      },
      30_000
    ).catch(() => null);

    if (!response || !response.ok) {
      return null;
    }

    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content?.trim() ?? null;
  }
}
