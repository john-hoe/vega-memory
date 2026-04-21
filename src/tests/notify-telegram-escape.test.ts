import assert from "node:assert/strict";
import test from "node:test";

import { TelegramNotifier } from "../notify/telegram.js";

test("TelegramNotifier omits parse_mode when message contains unsafe markdown characters", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";

  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  }) as typeof fetch;

  try {
    const notifier = new TelegramNotifier("123:token", "456");

    await notifier.send("alert *_[]()~`>#+-=|{}.!\\");

    const parsed = JSON.parse(requestBody) as {
      chat_id: string;
      parse_mode?: string;
      text: string;
    };
    assert.equal(parsed.chat_id, "456");
    assert.equal(parsed.parse_mode, undefined);
    assert.equal(parsed.text, "alert *_[]()~`>#+-=|{}.!\\");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TelegramNotifier keeps Markdown mode for plain-safe messages", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";

  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  }) as typeof fetch;

  try {
    const notifier = new TelegramNotifier("123:token", "456");

    await notifier.send("daily status summary");

    const parsed = JSON.parse(requestBody) as {
      parse_mode?: string;
      text: string;
    };
    assert.equal(parsed.parse_mode, "Markdown");
    assert.equal(parsed.text, "daily status summary");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
