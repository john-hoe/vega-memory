import type { VegaConfig } from "../config.js";
import { OllamaChatProvider, OllamaEmbeddingProvider } from "./ollama-provider.js";
import { OpenAIChatProvider, OpenAIEmbeddingProvider } from "./openai-provider.js";
import type { ChatProvider, EmbeddingProvider } from "./provider.js";

export const createEmbeddingProvider = (config: VegaConfig): EmbeddingProvider =>
  config.embeddingProvider === "openai"
    ? new OpenAIEmbeddingProvider(config)
    : new OllamaEmbeddingProvider(config);

export const createChatProvider = (config: VegaConfig): ChatProvider =>
  config.embeddingProvider === "openai"
    ? new OpenAIChatProvider(config)
    : new OllamaChatProvider(config);
