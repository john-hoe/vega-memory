import assert from "node:assert/strict";
import test from "node:test";

import type { AlertPayload } from "../alert/channels/index.js";
import {
  createSlackChannel,
  createTelegramChannel,
  createWebhookChannel
} from "../alert/channels/index.js";

const payload: AlertPayload = {
  alert_id: "alert_unsafe",
  severity: "critical",
  value: 92,
  threshold: 80,
  fired_at: "2026-04-21T00:00:00.000Z",
  message: "unsafe <value> & more > markdown _*[]()~`#+-=|{}.!"
};

test("createWebhookChannel rejects plain http for non-loopback hosts", () => {
  assert.throws(
    () =>
      createWebhookChannel({
        id: "default_webhook",
        url: "http://example.com/hooks"
      }),
    /plain http not allowed/i
  );
});

test("createWebhookChannel allows http loopback targets", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";

  globalThis.fetch = (async (input: URL | RequestInfo) => {
    requestUrl = String(input);
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const channel = createWebhookChannel({
      id: "default_webhook",
      url: "http://127.0.0.1:4318/hooks"
    });

    const result = await channel.send(payload);

    assert.deepEqual(result, { status: "ok" });
    assert.equal(requestUrl, "http://127.0.0.1:4318/hooks");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createSlackChannel validates Slack webhook URLs and escapes reserved characters", async () => {
  assert.throws(
    () =>
      createSlackChannel({
        id: "slack_default",
        url: "https://internal.example/hooks"
      }),
    /hooks\.slack/i
  );

  const originalFetch = globalThis.fetch;
  let requestBody = "";

  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const channel = createSlackChannel({
      id: "slack_default",
      url: "https://hooks.slack.com/services/T000/B000/XXX"
    });

    const result = await channel.send(payload);

    assert.deepEqual(result, { status: "ok" });
    const parsed = JSON.parse(requestBody) as {
      blocks: Array<{
        text: {
          text: string;
        };
      }>;
    };
    assert.match(parsed.blocks[0]?.text.text ?? "", /&lt;value&gt;/);
    assert.match(parsed.blocks[0]?.text.text ?? "", /&amp;/);
    assert.match(parsed.blocks[0]?.text.text ?? "", /more &gt;/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTelegramChannel escapes MarkdownV2 special characters", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";

  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const channel = createTelegramChannel({
      id: "telegram_default",
      botToken: "123:token",
      chatId: "456"
    });

    const result = await channel.send(payload);

    assert.deepEqual(result, { status: "ok" });
    const parsed = JSON.parse(requestBody) as {
      parse_mode: string;
      text: string;
    };
    assert.equal(parsed.parse_mode, "MarkdownV2");
    assert.match(parsed.text, /\\_/);
    assert.match(parsed.text, /\\\[/);
    assert.match(parsed.text, /\\\]/);
    assert.match(parsed.text, /\\~/);
    assert.match(parsed.text, /\\>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
