import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { generateEmbedding, chatWithOllama } from "../embedding/ollama.js";

const MIN_COMPRESSIBLE_LENGTH = 500;
const DEFAULT_BATCH_MIN_LENGTH = 1000;

const now = (): string => new Date().toISOString();

const toEmbeddingBuffer = (embedding: Float32Array | null): Buffer | null => {
  if (embedding === null) {
    return null;
  }

  return Buffer.from(
    embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength)
  );
};

export class CompressionService {
  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {}

  async compressMemory(
    memoryId: string
  ): Promise<{ original_length: number; compressed_length: number }> {
    const memory = this.repository.getMemory(memoryId);
    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    const original_length = memory.content.length;
    if (original_length < MIN_COMPRESSIBLE_LENGTH) {
      return {
        original_length,
        compressed_length: original_length
      };
    }

    const compressedContent = await chatWithOllama(
      [
        {
          role: "system",
          content:
            "Summarize the following technical note into a concise version. Keep all key facts, decisions, error messages, and solutions. Remove redundancy and filler. Output ONLY the summary, no preamble."
        },
        {
          role: "user",
          content: memory.content
        }
      ],
      this.config
    );

    if (compressedContent === null) {
      return {
        original_length,
        compressed_length: original_length
      };
    }

    const normalizedContent = compressedContent.trim();
    const compressed_length = normalizedContent.length;

    if (compressed_length === 0 || compressed_length >= original_length) {
      return {
        original_length,
        compressed_length
      };
    }

    const embedding = await generateEmbedding(normalizedContent, this.config);
    const updated_at = now();

    this.repository.createVersion(memory.id, memory.content, memory.embedding, memory.importance);
    this.repository.updateMemory(
      memory.id,
      {
        content: normalizedContent,
        embedding: toEmbeddingBuffer(embedding),
        updated_at
      },
      {
        skipVersion: true
      }
    );

    return {
      original_length,
      compressed_length
    };
  }

  async compressBatch(
    project?: string,
    minLength?: number
  ): Promise<{ processed: number; compressed: number; saved_chars: number }> {
    const threshold = minLength ?? DEFAULT_BATCH_MIN_LENGTH;
    const memories = this.repository
      .listMemories({
        project,
        status: "active",
        limit: 1_000_000
      })
      .filter((memory) => memory.content.length > threshold);
    let processed = 0;
    let compressed = 0;
    let saved_chars = 0;

    for (const memory of memories) {
      const result = await this.compressMemory(memory.id);

      processed += 1;

      if (result.compressed_length < result.original_length) {
        compressed += 1;
        saved_chars += result.original_length - result.compressed_length;
      }
    }

    return {
      processed,
      compressed,
      saved_chars
    };
  }
}
