import { RedisClient } from "./redis.js";

export class CacheManager {
  constructor(
    private redis: RedisClient,
    private prefix = "cache:"
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(this.buildKey(key));
    return value === null ? null : (JSON.parse(value) as T);
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.redis.set(this.buildKey(key), JSON.stringify(value), ttlSeconds);
  }

  async invalidate(pattern: string): Promise<void> {
    console.log(`Would invalidate pattern: ${pattern}`);
  }

  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds?: number): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const created = await factory();
    await this.set(key, created, ttlSeconds);
    return created;
  }

  private buildKey(key: string): string {
    return `${this.prefix}${key}`;
  }
}
