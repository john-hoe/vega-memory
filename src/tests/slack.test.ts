import assert from "node:assert/strict";
import test from "node:test";

import { SlackIntegration } from "../integrations/slack.js";

test("SlackIntegration.sendMessage returns false when Slack is disabled", async () => {
  const integration = new SlackIntegration({ enabled: false });
  const originalLog = console.log;
  const logs: unknown[][] = [];

  console.log = (...args: unknown[]): void => {
    logs.push(args);
  };

  try {
    const result = await integration.sendMessage({ text: "Hello" });

    assert.equal(result, false);
    assert.deepEqual(logs, [["Slack not configured"]]);
  } finally {
    console.log = originalLog;
  }
});

test("SlackIntegration.sendMessage posts to the configured webhook when enabled", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const integration = new SlackIntegration({
    enabled: true,
    webhookUrl: "https://hooks.slack.test/services/T000/B000/XXX",
    defaultChannel: "#alerts"
  }, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  });

  const result = await integration.sendMessage({ text: "Memory stored" });
  const body = JSON.parse(String(requests[0]?.init?.body ?? "{}")) as {
    text: string;
    channel: string;
  };

  assert.equal(result, true);
  assert.equal(requests[0]?.url, "https://hooks.slack.test/services/T000/B000/XXX");
  assert.deepEqual(body, {
    text: "Memory stored",
    channel: "#alerts"
  });
});

test("SlackIntegration.sendMessage throws when enabled without a webhook URL", async () => {
  const integration = new SlackIntegration({ enabled: true });

  await assert.rejects(
    integration.sendMessage({ text: "Hello" }),
    /Slack webhook URL is required when Slack integration is enabled/
  );
});

test("SlackIntegration.isConfigured requires both enabled flag and webhook URL", () => {
  assert.equal(new SlackIntegration({ enabled: false }).isConfigured(), false);
  assert.equal(
    new SlackIntegration({
      enabled: true
    }).isConfigured(),
    false
  );
  assert.equal(
    new SlackIntegration({
      enabled: true,
      webhookUrl: "https://hooks.slack.test/services/T000/B000/XXX"
    }).isConfigured(),
    true
  );
});
