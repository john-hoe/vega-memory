import type { VegaConfig } from "../config.js";
import { AzureOpenAIChatProvider, AzureOpenAIEmbeddingProvider } from "./azure-openai-provider.js";
import { BedrockChatProvider, BedrockEmbeddingProvider } from "./bedrock-provider.js";
import { OllamaChatProvider, OllamaEmbeddingProvider } from "./ollama-provider.js";
import { OpenAIChatProvider, OpenAIEmbeddingProvider } from "./openai-provider.js";
import type { ChatProvider, EmbeddingProvider } from "./provider.js";

export const createEmbeddingProvider = (config: VegaConfig): EmbeddingProvider =>
  config.embeddingProvider === "openai"
    ? new OpenAIEmbeddingProvider(config)
    : config.embeddingProvider === "azure-openai"
      ? new AzureOpenAIEmbeddingProvider(config)
      : config.embeddingProvider === "bedrock"
        ? new BedrockEmbeddingProvider(config)
        : new OllamaEmbeddingProvider(config);

export const createChatProvider = (config: VegaConfig): ChatProvider =>
  config.embeddingProvider === "openai"
    ? new OpenAIChatProvider(config)
    : config.embeddingProvider === "azure-openai"
      ? new AzureOpenAIChatProvider(config)
      : config.embeddingProvider === "bedrock"
        ? new BedrockChatProvider(config)
        : new OllamaChatProvider(config);
