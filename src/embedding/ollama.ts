import type { VegaConfig } from "../config.js";
import { createChatProvider, createEmbeddingProvider } from "./factory.js";
import { OllamaEmbeddingProvider } from "./ollama-provider.js";

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const generateEmbedding = async (
  text: string,
  config: VegaConfig
): Promise<Float32Array | null> => {
  const embedding = await createEmbeddingProvider(config).generateEmbedding(text);
  return embedding === null ? null : new Float32Array(embedding);
};

export const isOllamaAvailable = async (config: VegaConfig): Promise<boolean> => {
  return new OllamaEmbeddingProvider(config).isAvailable();
};

export const chatWithOllama = async (
  messages: OllamaChatMessage[],
  config: VegaConfig,
  timeoutMs = 30_000
): Promise<string | null> => {
  const provider = createChatProvider(config) as {
    chat(
      nextMessages: OllamaChatMessage[],
      options?: { model?: string; timeoutMs?: number }
    ): Promise<string | null>;
  };

  return provider.chat(messages, {
    model: config.ollamaModel,
    timeoutMs
  });
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
