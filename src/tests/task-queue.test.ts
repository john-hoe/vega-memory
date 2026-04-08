import assert from "node:assert/strict";
import test from "node:test";

import { TaskQueue } from "../queue/task-queue.js";
import { startMockRedisServer } from "./helpers/mock-redis.js";

test("TaskQueue addJob returns a completed result", async () => {
  const queue = new TaskQueue({
    enabled: true
  });

  const result = await queue.addJob({
    name: "index-memory",
    data: {
      memoryId: "m-1"
    }
  });

  assert.equal(result.name, "index-memory");
  assert.equal(result.status, "completed");
  assert.match(result.id, /^job-\d+$/);
});

test("TaskQueue addBulk processes all jobs", async () => {
  const queue = new TaskQueue({
    enabled: true
  });

  const results = await queue.addBulk([
    {
      name: "sync-memory",
      data: {
        memoryId: "m-1"
      }
    },
    {
      name: "sync-memory",
      data: {
        memoryId: "m-2"
      }
    }
  ]);

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => result.status),
    ["completed", "completed"]
  );
});

test("TaskQueue getJob and removeJob round-trip stored jobs", async () => {
  const queue = new TaskQueue({
    enabled: true
  });

  const result = await queue.addJob({
    name: "embed-memory",
    data: {
      memoryId: "m-1"
    }
  });

  assert.deepEqual(await queue.getJob(result.id), result);
  assert.equal(await queue.removeJob(result.id), true);
  assert.equal(await queue.getJob(result.id), null);
  assert.equal(await queue.removeJob(result.id), false);
});

test("TaskQueue reports queue stats and drain clears them", async () => {
  const queue = new TaskQueue({
    enabled: true
  });

  queue.registerProcessor("fail-job", async () => {
    throw new Error("processor failed");
  });

  await queue.addJob({
    name: "complete-job",
    data: {
      memoryId: "m-1"
    }
  });
  await queue.addJob({
    name: "fail-job",
    data: {
      memoryId: "m-2"
    }
  });

  assert.deepEqual(await queue.getQueueStats(), {
    waiting: 0,
    active: 0,
    completed: 1,
    failed: 1,
    delayed: 0
  });

  await queue.drain();

  assert.deepEqual(await queue.getQueueStats(), {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0
  });
});

test("TaskQueue registerProcessor uses the processor result", async () => {
  const server = await startMockRedisServer();

  try {
    const queue = new TaskQueue({
      enabled: true,
      defaultConcurrency: 4,
      redisUrl: `redis://127.0.0.1:${server.port}/1`
    });

    queue.registerProcessor("summarize-memory", async (data) => ({
      processed: true,
      memoryId: data.memoryId
    }));

    const result = await queue.addJob({
      name: "summarize-memory",
      data: {
        memoryId: "m-9"
      }
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, {
      processed: true,
      memoryId: "m-9"
    });
    assert.equal(queue.isConnected(), true);
  } finally {
    await server.close();
  }
});

test("TaskQueue disabled mode keeps the in-memory fallback available", async () => {
  const queue = new TaskQueue({
    enabled: false
  });

  const result = await queue.addJob({
    name: "fallback-job",
    data: {
      memoryId: "m-disabled"
    }
  });

  assert.equal(queue.isConnected(), false);
  assert.equal(result.status, "completed");
  assert.deepEqual(await queue.getQueueStats(), {
    waiting: 0,
    active: 0,
    completed: 1,
    failed: 0,
    delayed: 0
  });
});

test("TaskQueue honors delays before processing a job", async () => {
  const queue = new TaskQueue({
    enabled: true
  });

  queue.registerProcessor("delayed-job", async (data) => data.memoryId);

  const delayed = await queue.addJob({
    name: "delayed-job",
    data: {
      memoryId: "m-delay"
    },
    opts: {
      delay: 25
    }
  });

  assert.equal(delayed.status, "delayed");
  assert.deepEqual(await queue.getQueueStats(), {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 1
  });

  await new Promise((resolve) => setTimeout(resolve, 40));

  const result = await queue.getJob(delayed.id);

  assert.equal(result?.status, "completed");
  assert.equal(result?.result, "m-delay");
});

test("TaskQueue retries failed jobs up to the attempts limit", async () => {
  const queue = new TaskQueue({
    enabled: true
  });
  let calls = 0;

  queue.registerProcessor("retry-job", async () => {
    calls += 1;
    if (calls < 2) {
      throw new Error("first failure");
    }

    return "ok";
  });

  const result = await queue.addJob({
    name: "retry-job",
    data: {},
    opts: {
      attempts: 2
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls, 2);
  assert.equal((await queue.getJob(result.id))?.status, "completed");
});

test("TaskQueue persists state through the Redis-backed store", async () => {
  const server = await startMockRedisServer();
  const config = {
    enabled: true,
    redisUrl: `redis://127.0.0.1:${server.port}/4`
  };

  try {
    const firstQueue = new TaskQueue(config);
    const result = await firstQueue.addJob({
      name: "persisted-job",
      data: {
        memoryId: "m-persisted"
      }
    });

    const secondQueue = new TaskQueue(config);

    assert.deepEqual(await secondQueue.getJob(result.id), result);
  } finally {
    await server.close();
  }
});
