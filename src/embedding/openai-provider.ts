import type { VegaConfig } from "../config.js";
import { embeddingCache } from "./cache.js";
import type { ChatProvider, EmbeddingProvider } from "./provider.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const EMBEDDING_TIMEOUT_MS = 10_000;
const AVAILABILITY_TIMEOUT_MS = 3_000;
const DEFAULT_CHAT_TIMEOUT_MS = 30_000;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

interface OpenAIEmbeddingResponse {
  data?: Array<{
    embedding?: unknown;
  }>;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

type OpenAIConfig = Pick<
  VegaConfig,
  "openaiApiKey" | "openaiBaseUrl" | "openaiEmbeddingModel" | "ollamaModel"
>;

const normalizeBaseUrl = (value: string | undefined): string =>
  (value ?? OPENAI_BASE_URL).replace(/\/+$/, "");

const getEmbeddingModel = (config: Pick<VegaConfig, "openaiEmbeddingModel">): string =>
  config.openaiEmbeddingModel ?? DEFAULT_EMBEDDING_MODEL;

const getEmbeddingCacheNamespace = (config: OpenAIConfig): string =>
  `${normalizeBaseUrl(config.openaiBaseUrl)}\u0000${getEmbeddingModel(config)}`;

const buildHeaders = (apiKey: string | undefined): HeadersInit | null => {
  if (!apiKey) {
    return null;
  }

  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "api-key": apiKey
  };
};

const fetchWithTimeout = async (
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
};

const parseEmbedding = (value: unknown): number[] | null => {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const numbers = value.map((item) => (typeof item === "number" ? item : Number.NaN));
  return numbers.every((item) => Number.isFinite(item)) ? numbers : null;
};

const parseContent = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const joined = value
    .flatMap((item) =>
      typeof item === "object" &&
      item !== null &&
      "text" in item &&
      typeof item.text === "string"
        ? [item.text]
        : []
    )
    .join("")
    .trim();

  return joined.length > 0 ? joined : null;
};

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";

  constructor(private readonly config: OpenAIConfig) {}

  async generateEmbedding(text: string): Promise<number[] | null> {
    const headers = buildHeaders(this.config.openaiApiKey);
    if (headers === null) {
      return null;
    }

    const cacheNamespace = getEmbeddingCacheNamespace(this.config);
    const cached = embeddingCache.get(text, cacheNamespace);
    if (cached !== undefined) {
      return Array.from(cached);
    }

    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(this.config.openaiBaseUrl)}/embeddings`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: getEmbeddingModel(this.config),
          input: text
        })
      },
      EMBEDDING_TIMEOUT_MS
    ).catch(() => null);

    if (response === null || !response.ok) {
      return null;
    }

    const body = (await response.json()) as OpenAIEmbeddingResponse;
    const embedding = parseEmbedding(body.data?.[0]?.embedding);

    if (embedding !== null) {
      embeddingCache.set(text, new Float32Array(embedding), cacheNamespace);
    }

    return embedding;
  }

  async isAvailable(): Promise<boolean> {
    const headers = buildHeaders(this.config.openaiApiKey);
    if (headers === null) {
      return false;
    }

    try {
      const response = await fetchWithTimeout(
        `${normalizeBaseUrl(this.config.openaiBaseUrl)}/models`,
        {
          method: "GET",
          headers
        },
        AVAILABILITY_TIMEOUT_MS
      );

      return response.ok;
    } catch {
      return false;
    }
  }
}

export class OpenAIChatProvider implements ChatProvider {
  readonly name = "openai";

  constructor(private readonly config: OpenAIConfig) {}

  async chat(
    messages: { role: string; content: string }[],
    options?: { model?: string; timeoutMs?: number }
  ): Promise<string | null> {
    const headers = buildHeaders(this.config.openaiApiKey);
    if (headers === null) {
      return null;
    }

    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(this.config.openaiBaseUrl)}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: options?.model ?? this.config.ollamaModel,
          messages
        })
      },
      options?.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
    ).catch(() => null);

    if (response === null || !response.ok) {
      return null;
    }

    const body = (await response.json()) as OpenAIChatResponse;
    return parseContent(body.choices?.[0]?.message?.content);
  }
}
