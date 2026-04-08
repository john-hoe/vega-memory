import { Socket, connect as connectNet } from "node:net";
import { createRequire } from "node:module";
import { connect as connectTls, TLSSocket } from "node:tls";

const require = createRequire(import.meta.url);
const RedisCtor = require("ioredis") as new (options?: unknown, connectionOptions?: unknown) => {
  connect(): Promise<void>;
  disconnect(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  get(key: string): Promise<string | null>;
  set(...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
};

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

type RedisValue = string | number | null | RedisValue[] | Error;

interface ParsedRedisUrl {
  host: string;
  port: number;
  password?: string;
  db?: number;
  tls: boolean;
}

interface PendingResponse {
  resolve: (value: RedisValue) => void;
  reject: (error: Error) => void;
}

const isError = (value: RedisValue): value is Error => value instanceof Error;

const parseInteger = (value: string): number => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Redis integer: ${value}`);
  }

  return parsed;
};

const parseRedisUrl = (config: RedisConfig): ParsedRedisUrl | null => {
  if (config.url) {
    const parsed = new URL(config.url);

    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new Error(`Unsupported Redis protocol: ${parsed.protocol}`);
    }

    return {
      host: parsed.hostname || "127.0.0.1",
      port: parsed.port ? parseInteger(parsed.port) : 6379,
      password: parsed.password || config.password,
      db:
        parsed.pathname.length > 1
          ? parseInteger(parsed.pathname.slice(1))
          : config.db,
      tls: parsed.protocol === "rediss:"
    };
  }

  if (config.host || config.port || config.password || config.db !== undefined) {
    return {
      host: config.host ?? "127.0.0.1",
      port: config.port ?? 6379,
      password: config.password,
      db: config.db,
      tls: false
    };
  }

  return null;
};

const encodeCommand = (parts: Array<string | number>): string =>
  `*${parts.length}\r\n${parts
    .map((part) => {
      const value = String(part);

      return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
    })
    .join("")}`;

const parseRedisReply = (
  buffer: Buffer,
  offset = 0
): { value: RedisValue; nextOffset: number } | null => {
  if (offset >= buffer.length) {
    return null;
  }

  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf("\r\n", offset);

  if (lineEnd === -1) {
    return null;
  }

  const payload = buffer.toString("utf8", offset + 1, lineEnd);
  const nextOffset = lineEnd + 2;

  if (type === "+") {
    return {
      value: payload,
      nextOffset
    };
  }

  if (type === "-") {
    return {
      value: new Error(payload),
      nextOffset
    };
  }

  if (type === ":") {
    return {
      value: parseInteger(payload),
      nextOffset
    };
  }

  if (type === "$") {
    const length = parseInteger(payload);

    if (length === -1) {
      return {
        value: null,
        nextOffset
      };
    }

    const endOffset = nextOffset + length;
    if (buffer.length < endOffset + 2) {
      return null;
    }

    return {
      value: buffer.toString("utf8", nextOffset, endOffset),
      nextOffset: endOffset + 2
    };
  }

  if (type === "*") {
    const length = parseInteger(payload);

    if (length === -1) {
      return {
        value: null,
        nextOffset
      };
    }

    const values: RedisValue[] = [];
    let cursor = nextOffset;

    for (let index = 0; index < length; index += 1) {
      const parsed = parseRedisReply(buffer, cursor);
      if (parsed === null) {
        return null;
      }

      values.push(parsed.value);
      cursor = parsed.nextOffset;
    }

    return {
      value: values,
      nextOffset: cursor
    };
  }

  throw new Error(`Unsupported Redis response type: ${type}`);
};

export class RedisClient {
  private connected = false;

  private readonly store = new Map<string, CacheEntry>();

  private redis: InstanceType<typeof RedisCtor> | null = null;

  private socket: Socket | TLSSocket | null = null;

  private buffer = Buffer.alloc(0);

  private readonly pendingResponses: PendingResponse[] = [];

  private connectPromise: Promise<void> | null = null;

  constructor(private config: RedisConfig) {}

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      console.log("Redis disabled, using in-memory fallback");
      return;
    }

    if (this.connected) {
      return;
    }

    if (this.connectPromise !== null) {
      return this.connectPromise;
    }

    const endpoint = parseRedisUrl(this.config);
    if (endpoint === null) {
      console.log("Redis target not configured, using in-memory fallback");
      return;
    }

    this.connectPromise = (async () => {
      const remoteTarget = this.config.url ?? {
        host: endpoint.host,
        port: endpoint.port,
        password: endpoint.password,
        db: endpoint.db
      };

      try {
        const redis = new RedisCtor(remoteTarget, {
          lazyConnect: true,
          enableReadyCheck: false,
          maxRetriesPerRequest: 0,
          retryStrategy: () => null,
          ...(endpoint.tls ? { tls: {} } : {})
        });
        redis.on("error", () => {});
        await redis.connect();
        this.redis = redis;
        this.connected = true;
        return;
      } catch {
        this.redis?.disconnect();
        this.redis = null;
      }

      const socket = endpoint.tls
        ? connectTls({
            host: endpoint.host,
            port: endpoint.port
          })
        : connectNet({
            host: endpoint.host,
            port: endpoint.port
          });

      this.socket = socket;
      this.buffer = Buffer.alloc(0);

      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          socket.off("connect", onConnect);
          socket.off("secureConnect", onConnect);
          socket.off("error", onError);
        };
        const onConnect = (): void => {
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };

        socket.once(endpoint.tls ? "secureConnect" : "connect", onConnect);
        socket.once("error", onError);
      });

      socket.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.flushBuffer();
      });
      socket.on("error", (error) => {
        this.failPending(error instanceof Error ? error : new Error(String(error)));
      });
      socket.on("close", () => {
        this.connected = false;
        this.socket = null;
      });

      this.connected = true;

      if (endpoint.password) {
        await this.command("AUTH", endpoint.password);
      }

      if (endpoint.db !== undefined) {
        await this.command("SELECT", endpoint.db);
      }
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async disconnect(): Promise<void> {
    this.failPending(new Error("Redis connection closed"));
    this.redis?.disconnect();
    this.redis = null;
    if (this.socket !== null) {
      const socket = this.socket;
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
      });
    }

    this.socket = null;
    this.connected = false;
  }

  async get(key: string): Promise<string | null> {
    if (await this.ensureRemote()) {
      if (this.redis !== null) {
        return await this.redis.get(this.buildKey(key));
      }

      const value = await this.command("GET", this.buildKey(key));
      return value === null ? null : String(value);
    }

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
    if (await this.ensureRemote()) {
      if (this.redis !== null) {
        if (ttlSeconds !== undefined) {
          await this.redis.set(this.buildKey(key), value, "EX", Math.max(Math.trunc(ttlSeconds), 0));
        } else {
          await this.redis.set(this.buildKey(key), value);
        }
        return;
      }

      const parts: Array<string | number> = ["SET", this.buildKey(key), value];
      if (ttlSeconds !== undefined) {
        parts.push("EX", Math.max(Math.trunc(ttlSeconds), 0));
      }
      await this.command(...parts);
      return;
    }

    const expiresAt =
      ttlSeconds === undefined ? undefined : Date.now() + Math.max(ttlSeconds, 0) * 1000;

    this.store.set(this.buildKey(key), {
      value,
      ...(expiresAt === undefined ? {} : { expiresAt })
    });
  }

  async del(key: string): Promise<void> {
    if (await this.ensureRemote()) {
      if (this.redis !== null) {
        await this.redis.del(this.buildKey(key));
        return;
      }

      await this.command("DEL", this.buildKey(key));
      return;
    }

    this.store.delete(this.buildKey(key));
  }

  async exists(key: string): Promise<boolean> {
    if (await this.ensureRemote()) {
      if (this.redis !== null) {
        return (await this.redis.exists(this.buildKey(key))) > 0;
      }

      return Number(await this.command("EXISTS", this.buildKey(key))) > 0;
    }

    return (await this.get(key)) !== null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    return value === null ? null : (JSON.parse(value) as T);
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async incr(key: string): Promise<number> {
    if (await this.ensureRemote()) {
      if (this.redis !== null) {
        return await this.redis.incr(this.buildKey(key));
      }

      return Number(await this.command("INCR", this.buildKey(key)));
    }

    const current = Number.parseInt((await this.get(key)) ?? "0", 10);
    const nextValue = Number.isFinite(current) ? current + 1 : 1;
    await this.set(key, String(nextValue));
    return nextValue;
  }

  async keys(pattern: string): Promise<string[]> {
    if (await this.ensureRemote()) {
      if (this.redis !== null) {
        return await this.redis.keys(this.buildKey(pattern));
      }

      const values = await this.command("KEYS", this.buildKey(pattern));
      return Array.isArray(values)
        ? values.flatMap((value) => (typeof value === "string" ? [value] : []))
        : [];
    }

    const matcher = this.createPatternMatcher(this.buildKey(pattern));
    return [...this.store.keys()].filter((key) => matcher(key));
  }

  async deleteByPattern(pattern: string): Promise<number> {
    const keys = await this.keys(pattern);
    if (keys.length === 0) {
      return 0;
    }

    if (await this.ensureRemote()) {
      if (this.redis !== null) {
        return await this.redis.del(...keys);
      }

      const deleted = await this.command("DEL", ...keys);
      return typeof deleted === "number" ? deleted : 0;
    }

    let deleted = 0;
    for (const key of keys) {
      deleted += this.store.delete(key) ? 1 : 0;
    }
    return deleted;
  }

  private buildKey(key: string): string {
    return `${this.config.keyPrefix ?? ""}${key}`;
  }

  private async ensureRemote(): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    try {
      await this.connect();
    } catch {
      this.connected = false;
      this.redis = null;
      this.socket = null;
    }

    return this.connected && (this.redis !== null || this.socket !== null);
  }

  private async command(...parts: Array<string | number>): Promise<RedisValue> {
    if (this.socket === null || !this.connected) {
      throw new Error("Redis socket is not connected");
    }

    const socket = this.socket;

    return new Promise<RedisValue>((resolve, reject) => {
      this.pendingResponses.push({ resolve, reject });
      socket.write(encodeCommand(parts), "utf8", (error) => {
        if (error) {
          const pending = this.pendingResponses.pop();
          pending?.reject(error);
        }
      });
    }).then((value) => {
      if (isError(value)) {
        throw value;
      }

      return value;
    });
  }

  private flushBuffer(): void {
    let offset = 0;

    while (offset < this.buffer.length && this.pendingResponses.length > 0) {
      const parsed = parseRedisReply(this.buffer, offset);
      if (parsed === null) {
        break;
      }

      offset = parsed.nextOffset;
      this.pendingResponses.shift()?.resolve(parsed.value);
    }

    this.buffer = offset >= this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(offset);
  }

  private failPending(error: Error): void {
    while (this.pendingResponses.length > 0) {
      this.pendingResponses.shift()?.reject(error);
    }
  }

  private createPatternMatcher(pattern: string): (value: string) => boolean {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    const regex = new RegExp(`^${escaped}$`);

    return (value: string): boolean => regex.test(value);
  }
}
