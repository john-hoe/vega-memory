import type { VegaConfig } from "../config.js";
import { embeddingCache } from "./cache.js";
import type { ChatProvider, EmbeddingProvider } from "./provider.js";

const EMBEDDING_TIMEOUT_MS = 10_000;
const AVAILABILITY_TIMEOUT_MS = 3_000;
const DEFAULT_CHAT_TIMEOUT_MS = 30_000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

interface OllamaChatResponse {
  message?: {
    content?: unknown;
  };
  response?: unknown;
}

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const getEmbeddingCacheNamespace = (config: Pick<VegaConfig, "ollamaBaseUrl" | "ollamaModel">): string =>
  `${normalizeBaseUrl(config.ollamaBaseUrl)}\u0000${config.ollamaModel}`;

const sleep = async (delayMs: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

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

  const first = value[0];
  if (!Array.isArray(first)) {
    return null;
  }

  const numbers = first.map((item) => (typeof item === "number" ? item : Number.NaN));
  return numbers.every((item) => Number.isFinite(item)) ? numbers : null;
};

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";

  constructor(private readonly config: Pick<VegaConfig, "ollamaBaseUrl" | "ollamaModel">) {}

  async generateEmbedding(text: string): Promise<number[] | null> {
    const cacheNamespace = getEmbeddingCacheNamespace(this.config);
    const cached = embeddingCache.get(text, cacheNamespace);
    if (cached !== undefined) {
      return Array.from(cached);
    }

    const url = `${normalizeBaseUrl(this.config.ollamaBaseUrl)}/api/embed`;

    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              model: this.config.ollamaModel,
              input: text
            })
          },
          EMBEDDING_TIMEOUT_MS
        );

        if (!response.ok) {
          throw new Error(`Ollama embed request failed with status ${response.status}`);
        }

        const body = (await response.json()) as OllamaEmbedResponse;
        const embedding = parseEmbedding(body.embeddings);

        if (embedding !== null) {
          embeddingCache.set(text, new Float32Array(embedding), cacheNamespace);
          return embedding;
        }

        throw new Error("Ollama embed response did not include a valid embedding");
      } catch {
        if (attempt < RETRY_ATTEMPTS - 1) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    return null;
  }

  async isAvailable(): Promise<boolean> {
    const url = `${normalizeBaseUrl(this.config.ollamaBaseUrl)}/api/version`;

    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "GET"
        },
        AVAILABILITY_TIMEOUT_MS
      );

      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export class OllamaChatProvider implements ChatProvider {
  readonly name = "ollama";

  constructor(private readonly config: Pick<VegaConfig, "ollamaBaseUrl" | "ollamaModel">) {}

  async chat(
    messages: { role: string; content: string }[],
    options?: { model?: string; timeoutMs?: number }
  ): Promise<string | null> {
    const url = `${normalizeBaseUrl(this.config.ollamaBaseUrl)}/api/chat`;

    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: options?.model ?? this.config.ollamaModel,
            stream: false,
            messages
          })
        },
        options?.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
      );

      if (!response.ok) {
        return null;
      }

      const body = (await response.json()) as OllamaChatResponse;
      const content =
        typeof body.message?.content === "string"
          ? body.message.content
          : typeof body.response === "string"
            ? body.response
            : null;

      return content?.trim() || null;
    } catch {
      return null;
    }
  }
}
