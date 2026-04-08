import { RedisClient } from "./redis.js";

export class RedisSessionStore {
  constructor(
    private redis: RedisClient,
    private prefix = "sess:"
  ) {}

  async getSession(id: string): Promise<Record<string, unknown> | null> {
    const value = await this.redis.get(this.buildKey(id));
    return value === null ? null : (JSON.parse(value) as Record<string, unknown>);
  }

  async setSession(
    id: string,
    data: Record<string, unknown>,
    ttlSeconds?: number
  ): Promise<void> {
    await this.redis.set(this.buildKey(id), JSON.stringify(data), ttlSeconds);
  }

  async deleteSession(id: string): Promise<void> {
    await this.redis.del(this.buildKey(id));
  }

  private buildKey(id: string): string {
    return `${this.prefix}${id}`;
  }
}
