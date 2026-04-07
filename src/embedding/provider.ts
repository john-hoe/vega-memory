export interface EmbeddingProvider {
  name: string;
  generateEmbedding(text: string): Promise<number[] | null>;
  isAvailable(): Promise<boolean>;
}

export interface ChatProvider {
  name: string;
  chat(messages: { role: string; content: string }[], options?: { model?: string }): Promise<string | null>;
}
