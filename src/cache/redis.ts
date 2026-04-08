export interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  enabled: boolean;
}

interface CacheEntry {
  value: string;
  expiresAt?: number;
}

export class RedisClient {
  private connected = false;

  private readonly store = new Map<string, CacheEntry>();

  constructor(private config: RedisConfig) {}

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      console.log("Redis disabled, using in-memory fallback");
      return;
    }

    const target =
      this.config.url ?? `${this.config.host ?? "localhost"}:${this.config.port ?? 6379}`;
    console.log(`Would connect to ${target}`);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(this.buildKey(key));
    if (entry === undefined) {
      return null;
    }

    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(this.buildKey(key));
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt =
      ttlSeconds === undefined ? undefined : Date.now() + Math.max(ttlSeconds, 0) * 1000;

    this.store.set(this.buildKey(key), {
      value,
      ...(expiresAt === undefined ? {} : { expiresAt })
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(this.buildKey(key));
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private buildKey(key: string): string {
    return `${this.config.keyPrefix ?? ""}${key}`;
  }
}
