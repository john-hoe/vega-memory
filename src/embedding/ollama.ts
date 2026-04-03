import type { VegaConfig } from "../config.js";

const EMBEDDING_TIMEOUT_MS = 10_000;
const AVAILABILITY_TIMEOUT_MS = 3_000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

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

const parseEmbedding = (value: unknown): Float32Array | null => {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const first = value[0];
  if (!Array.isArray(first)) {
    return null;
  }

  const numbers = first.map((item) => (typeof item === "number" ? item : Number.NaN));
  return numbers.every((item) => Number.isFinite(item)) ? new Float32Array(numbers) : null;
};

export const generateEmbedding = async (
  text: string,
  config: VegaConfig
): Promise<Float32Array | null> => {
  const url = `${config.ollamaBaseUrl.replace(/\/+$/, "")}/api/embed`;

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
            model: config.ollamaModel,
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
};

export const isOllamaAvailable = async (config: VegaConfig): Promise<boolean> => {
  const url = `${config.ollamaBaseUrl.replace(/\/+$/, "")}/api/version`;

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
};

export const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
  const length = Math.min(a.length, b.length);
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let index = 0; index < length; index += 1) {
    dotProduct += a[index] * b[index];
    magnitudeA += a[index] * a[index];
    magnitudeB += b[index] * b[index];
  }

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
};
