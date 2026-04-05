import { createHash } from "node:crypto";

const createKey = (text: string, namespace: string): string =>
  createHash("sha256")
    .update(namespace)
    .update("\u0000")
    .update(text)
    .digest("hex");

export class EmbeddingCache {
  private readonly entries = new Map<string, Float32Array>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxSize = 1000) {}

  get(text: string, namespace = ""): Float32Array | undefined {
    const key = createKey(text, namespace);
    const cached = this.entries.get(key);

    if (!cached) {
      this.misses += 1;
      return undefined;
    }

    this.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, cached);
    return new Float32Array(cached);
  }

  set(text: string, embedding: Float32Array, namespace = ""): void {
    const key = createKey(text, namespace);
    const nextValue = new Float32Array(embedding);

    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    this.entries.set(key, nextValue);

    while (this.entries.size > this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }

      this.entries.delete(oldestKey);
    }
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  size(): number {
    return this.entries.size;
  }

  hitRate(): { hits: number; misses: number; rate: number } {
    const total = this.hits + this.misses;

    return {
      hits: this.hits,
      misses: this.misses,
      rate: total === 0 ? 0 : this.hits / total
    };
  }
}

export const embeddingCache = new EmbeddingCache();
