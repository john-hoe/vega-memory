import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand
} from "@aws-sdk/client-bedrock-runtime";

import type { VegaConfig } from "../config.js";
import { embeddingCache } from "./cache.js";
import type { ChatProvider, EmbeddingProvider } from "./provider.js";

type BedrockConfig = Pick<VegaConfig, "bedrockRegion" | "bedrockChatModel" | "bedrockEmbeddingModel">;

interface BedrockLikeClient {
  send(command: unknown): Promise<unknown>;
}

const streamToString = (body: Uint8Array | Buffer | undefined): string | null =>
  body ? Buffer.from(body).toString("utf8") : null;

export class BedrockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "bedrock";

  private readonly client: BedrockLikeClient | null;

  constructor(private readonly config: BedrockConfig, client?: BedrockLikeClient) {
    this.client =
      client ??
      (config.bedrockRegion
        ? new BedrockRuntimeClient({
            region: config.bedrockRegion
          })
        : null);
  }

  async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.client || !this.config.bedrockEmbeddingModel) {
      return null;
    }

    const cacheNamespace = `${this.config.bedrockRegion ?? ""}\u0000${this.config.bedrockEmbeddingModel}`;
    const cached = embeddingCache.get(text, cacheNamespace);
    if (cached !== undefined) {
      return Array.from(cached);
    }

    const response = (await this.client.send(
      new InvokeModelCommand({
        modelId: this.config.bedrockEmbeddingModel,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          inputText: text
        })
      })
    )) as { body?: Uint8Array | Buffer };
    const parsed = JSON.parse(streamToString(response.body) ?? "{}") as {
      embedding?: number[];
      embeddings?: Array<{ values?: number[] }>;
    };
    const embedding = parsed.embedding ?? parsed.embeddings?.[0]?.values;

    if (Array.isArray(embedding) && embedding.every((value) => typeof value === "number")) {
      embeddingCache.set(text, new Float32Array(embedding), cacheNamespace);
      return embedding;
    }

    return null;
  }

  async isAvailable(): Promise<boolean> {
    return this.client !== null && typeof this.config.bedrockEmbeddingModel === "string";
  }
}

export class BedrockChatProvider implements ChatProvider {
  readonly name = "bedrock";

  private readonly client: BedrockLikeClient | null;

  constructor(private readonly config: BedrockConfig, client?: BedrockLikeClient) {
    this.client =
      client ??
      (config.bedrockRegion
        ? new BedrockRuntimeClient({
            region: config.bedrockRegion
          })
        : null);
  }

  async chat(messages: { role: string; content: string }[]): Promise<string | null> {
    if (!this.client || !this.config.bedrockChatModel) {
      return null;
    }

    const response = (await this.client.send(
      new ConverseCommand({
        modelId: this.config.bedrockChatModel,
        messages: messages.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: [{ text: message.content }]
        }))
      })
    )) as {
      output?: {
        message?: {
          content?: Array<{ text?: string }>;
        };
      };
    };

    return response.output?.message?.content?.[0]?.text?.trim() ?? null;
  }
}
