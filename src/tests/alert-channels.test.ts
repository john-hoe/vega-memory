import assert from "node:assert/strict";
import test from "node:test";

import {
  createSlackChannel,
  createTelegramChannel,
  createWebhookChannel,
  type AlertPayload
} from "../alert/index.js";

const payload: AlertPayload = {
  alert_id: "circuit_breaker_open",
  severity: "critical",
  value: 1,
  threshold: 0,
  fired_at: "2026-04-20T00:00:00.000Z",
  message: "Circuit breaker is open"
};

test("createWebhookChannel sends the base alert payload", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: string | null }> = [];

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : null
    });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const channel = createWebhookChannel({
      id: "default_webhook",
      url: "https://hooks.example/vega"
    });
    const result = await channel.send(payload);

    assert.deepEqual(result, { status: "ok" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://hooks.example/vega");
    assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), payload);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createWebhookChannel retries 5xx responses before succeeding", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response(null, {
      status: attempts < 3 ? 503 : 200
    });
  }) as typeof fetch;

  try {
    const channel = createWebhookChannel({
      id: "default_webhook",
      url: "https://hooks.example/vega",
      retryDelaysMs: [0, 0, 0]
    });
    const result = await channel.send(payload);

    assert.deepEqual(result, { status: "ok" });
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createWebhookChannel returns an error after exhausting retries", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response(null, { status: 503, statusText: "Service Unavailable" });
  }) as typeof fetch;

  try {
    const channel = createWebhookChannel({
      id: "default_webhook",
      url: "https://hooks.example/vega",
      retryDelaysMs: [0, 0, 0]
    });
    const result = await channel.send(payload);

    assert.equal(result.status, "error");
    assert.equal(attempts, 3);
    assert.match(result.message, /503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createWebhookChannel does not retry 4xx responses", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response(null, { status: 400, statusText: "Bad Request" });
  }) as typeof fetch;

  try {
    const channel = createWebhookChannel({
      id: "default_webhook",
      url: "https://hooks.example/vega",
      retryDelaysMs: [0, 0, 0]
    });
    const result = await channel.send(payload);

    assert.equal(result.status, "error");
    assert.equal(attempts, 1);
    assert.match(result.message, /400/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createSlackChannel wraps alerts in a Slack blocks payload", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";

  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const channel = createSlackChannel({
      id: "slack_default",
      url: "https://hooks.slack.example/services/TOKEN",
      retryDelaysMs: [0, 0, 0]
    });

    await channel.send(payload);

    const parsed = JSON.parse(requestBody) as {
      text: string;
      blocks: Array<{ type: string; text?: { type: string; text: string } }>;
    };
    assert.equal(parsed.text, "critical: circuit_breaker_open");
    assert.equal(parsed.blocks[0]?.type, "section");
    assert.match(parsed.blocks[0]?.text?.text ?? "", /Circuit breaker is open/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTelegramChannel wraps alerts in a Telegram sendMessage payload", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody = "";

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? "");
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const channel = createTelegramChannel({
      id: "telegram_default",
      botToken: "123:token",
      chatId: "456",
      retryDelaysMs: [0, 0, 0]
    });

    await channel.send(payload);

    const parsed = JSON.parse(requestBody) as {
      chat_id: string;
      text: string;
      parse_mode: string;
    };
    assert.equal(requestUrl, "https://api.telegram.org/bot123:token/sendMessage");
    assert.equal(parsed.chat_id, "456");
    assert.equal(parsed.parse_mode, "Markdown");
    assert.match(parsed.text, /circuit_breaker_open/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
