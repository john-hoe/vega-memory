import assert from "node:assert/strict";
import test from "node:test";

import { CacheManager } from "../cache/cache-manager.js";
import { RedisClient } from "../cache/redis.js";
import { RedisSessionStore } from "../cache/session-store.js";
import { startMockRedisServer } from "./helpers/mock-redis.js";

test("RedisClient uses the in-memory fallback for get/set/del/exists", async () => {
  const redis = new RedisClient({
    enabled: true,
    keyPrefix: "vega:"
  });

  await redis.set("memory", "value");

  assert.equal(await redis.get("memory"), "value");
  assert.equal(await redis.exists("memory"), true);

  await redis.del("memory");

  assert.equal(await redis.get("memory"), null);
  assert.equal(await redis.exists("memory"), false);
});

test("RedisSessionStore performs CRUD with JSON serialization", async () => {
  const redis = new RedisClient({
    enabled: true
  });
  const store = new RedisSessionStore(redis);

  await store.setSession("abc", {
    userId: "u1",
    role: "admin"
  });

  assert.deepEqual(await store.getSession("abc"), {
    userId: "u1",
    role: "admin"
  });

  await store.deleteSession("abc");

  assert.equal(await store.getSession("abc"), null);
});

test("CacheManager getOrSet caches the factory result", async () => {
  const redis = new RedisClient({
    enabled: true
  });
  const cache = new CacheManager(redis);
  let calls = 0;

  const first = await cache.getOrSet("answer", async () => {
    calls += 1;
    return { value: 42 };
  });
  const second = await cache.getOrSet("answer", async () => {
    calls += 1;
    return { value: 0 };
  });

  assert.deepEqual(first, { value: 42 });
  assert.deepEqual(second, { value: 42 });
  assert.equal(calls, 1);
});

test("RedisClient connect logs the disabled fallback message", async () => {
  const redis = new RedisClient({
    enabled: false
  });
  const originalLog = console.log;
  const messages: string[] = [];

  console.log = (...args: unknown[]): void => {
    messages.push(args.map(String).join(" "));
  };

  try {
    await redis.connect();
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(messages, ["Redis disabled, using in-memory fallback"]);
  assert.equal(redis.isConnected(), false);
});

test("RedisClient uses a live Redis-compatible server when configured", async () => {
  const server = await startMockRedisServer();
  const redis = new RedisClient({
    enabled: true,
    url: `redis://127.0.0.1:${server.port}/2`,
    keyPrefix: "vega:"
  });

  try {
    await redis.connect();
    await redis.set("memory", "remote-value");

    assert.equal(redis.isConnected(), true);
    assert.equal(await redis.get("memory"), "remote-value");
    assert.deepEqual(await redis.keys("mem*"), ["vega:memory"]);
    assert.equal(await redis.deleteByPattern("mem*"), 1);
    assert.equal(await redis.get("memory"), null);
  } finally {
    await redis.disconnect();
    await server.close();
  }
});

test("RedisSessionStore deletes malformed JSON payloads", async () => {
  const redis = new RedisClient({
    enabled: true
  });
  const store = new RedisSessionStore(redis);

  await redis.set("sess:broken", "{oops");

  assert.equal(await store.getSession("broken"), null);
  assert.equal(await redis.get("sess:broken"), null);
});
