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

test("SlackIntegration.sendMessage logs stub output when Slack is enabled", async () => {
  const integration = new SlackIntegration({
    enabled: true,
    webhookUrl: "https://hooks.slack.test/services/T000/B000/XXX",
    defaultChannel: "#alerts"
  });
  const originalLog = console.log;
  const logs: unknown[][] = [];

  console.log = (...args: unknown[]): void => {
    logs.push(args);
  };

  try {
    const result = await integration.sendMessage({ text: "Memory stored" });

    assert.equal(result, true);
    assert.deepEqual(logs, [
      [
        "Slack message would be sent:",
        {
          text: "Memory stored",
          channel: "#alerts"
        }
      ]
    ]);
  } finally {
    console.log = originalLog;
  }
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
