import assert from "node:assert/strict";
import test from "node:test";

import { StructuredLogger } from "../monitoring/logger.js";
import { MetricsCollector } from "../monitoring/metrics.js";
import { SentryStub } from "../monitoring/sentry.js";

const captureStderr = async (run: () => Promise<void> | void): Promise<string[]> => {
  const messages: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);

  process.stderr.write = ((chunk: string | Uint8Array) => {
    messages.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await run();
    return messages;
  } finally {
    process.stderr.write = originalWrite;
  }
};

test("MetricsCollector renders counter samples in Prometheus text format", async () => {
  const collector = new MetricsCollector({
    enabled: true,
    prefix: "vega"
  });
  const counter = collector.counter("requests_total", "Total requests", ["method", "status"]);

  counter.inc({ method: "GET", status: "200" });
  counter.inc({ method: "GET", status: "200" }, 2);

  const metrics = await collector.getMetrics();

  assert.match(metrics, /# HELP vega_requests_total Total requests/);
  assert.match(metrics, /# TYPE vega_requests_total counter/);
  assert.match(metrics, /vega_requests_total\{method="GET",status="200"\} 3/);
});

test("MetricsCollector renders histogram buckets, sum, and count", async () => {
  const collector = new MetricsCollector({ enabled: true });
  const histogram = collector.histogram(
    "request_duration_seconds",
    "Request duration",
    [0.1, 0.5, 1],
    ["route"]
  );

  histogram.observe(0.2, { route: "/api/health" });
  histogram.observe(0.8, { route: "/api/health" });

  const metrics = await collector.getMetrics();

  assert.match(metrics, /request_duration_seconds\{route="\/api\/health",le="0.1"\} 0/);
  assert.match(metrics, /request_duration_seconds\{route="\/api\/health",le="0.5"\} 1/);
  assert.match(metrics, /request_duration_seconds\{route="\/api\/health",le="1"\} 2/);
  assert.match(metrics, /request_duration_seconds\{route="\/api\/health",le="\+Inf"\} 2/);
  assert.match(metrics, /request_duration_seconds_sum\{route="\/api\/health"\} 1/);
  assert.match(metrics, /request_duration_seconds_count\{route="\/api\/health"\} 2/);
});

test("SentryStub captures events with user and tag context", () => {
  const calls: Array<{ type: string; payload: unknown }> = [];
  const sentry = new SentryStub({
    dsn: "https://example@sentry.test/123",
    environment: "test",
    enabled: true
  }, {
    init(config) {
      calls.push({ type: "init", payload: config });
    },
    captureException(error, scope) {
      calls.push({ type: "exception", payload: { error, scope } });
      return "exception-id";
    },
    captureMessage(message, scope) {
      calls.push({ type: "message", payload: { message, scope } });
      return "message-id";
    },
    setUser(user) {
      calls.push({ type: "user", payload: user });
    },
    setTag(key, value) {
      calls.push({ type: "tag", payload: { key, value } });
    }
  });

  sentry.setUser({ id: "user-1", email: "user@example.com" });
  sentry.setTag("component", "sync");
  const exceptionId = sentry.captureException(new Error("boom"), { job: "index" });
  const messageId = sentry.captureMessage("sync completed", "warning");
  const events = sentry.getEvents();
  const firstData = events[0]?.data as {
    error: { name: string; message: string; stack?: string };
    context: Record<string, unknown>;
    environment: string;
    enabled: boolean;
    user: { id: string; email?: string };
    tags: Record<string, string>;
  };

  assert.equal(sentry.isConfigured(), true);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.id, "exception-id");
  assert.equal(events[1]?.id, "message-id");
  assert.equal(events[0]?.type, "exception");
  assert.equal(events[1]?.type, "message");
  assert.equal(firstData.error.name, "Error");
  assert.equal(firstData.error.message, "boom");
  assert.equal(typeof firstData.error.stack, "string");
  assert.deepEqual(firstData.context, { job: "index" });
  assert.equal(firstData.environment, "test");
  assert.equal(firstData.enabled, true);
  assert.deepEqual(firstData.user, {
    id: "user-1",
    email: "user@example.com"
  });
  assert.deepEqual(firstData.tags, {
    component: "sync"
  });
  assert.deepEqual(events[1]?.data, {
    message: "sync completed",
    level: "warning",
    environment: "test",
    enabled: true,
    user: {
      id: "user-1",
      email: "user@example.com"
    },
    tags: {
      component: "sync"
    }
  });
  assert.ok(calls.some((call) => call.type === "init"));
  assert.ok(calls.some((call) => call.type === "message"));
});

test("StructuredLogger emits JSON lines to stderr", async () => {
  const lines = await captureStderr(() => {
    const logger = new StructuredLogger({
      level: "info",
      format: "json",
      service: "vega-memory"
    });

    logger.info("server started", { port: 3271 });
  });
  const payload = JSON.parse(lines.join("").trim()) as Record<string, unknown>;

  assert.equal(payload.level, "info");
  assert.equal(payload.message, "server started");
  assert.equal(payload.service, "vega-memory");
  assert.equal(payload.port, 3271);
  assert.equal(typeof payload.timestamp, "string");
});

test("StructuredLogger child loggers inherit bound metadata", async () => {
  const lines = await captureStderr(() => {
    const parent = new StructuredLogger({
      level: "debug",
      format: "json",
      service: "vega-memory"
    });
    const child = parent.child({ component: "sync", tenant: "tenant-a" });

    child.warn("retry scheduled", { attempt: 2 });
  });
  const payload = JSON.parse(lines.join("").trim()) as Record<string, unknown>;

  assert.equal(payload.level, "warn");
  assert.equal(payload.message, "retry scheduled");
  assert.equal(payload.service, "vega-memory");
  assert.equal(payload.component, "sync");
  assert.equal(payload.tenant, "tenant-a");
  assert.equal(payload.attempt, 2);
});
