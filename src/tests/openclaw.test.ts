import assert from "node:assert/strict";
import test from "node:test";

import { OpenClawClient } from "../integrations/openclaw.js";

test("OpenClawClient.search returns empty results when OpenClaw is not connected", async () => {
  const client = new OpenClawClient({ enabled: true });
  const originalLog = console.log;
  const logs: unknown[][] = [];

  console.log = (...args: unknown[]): void => {
    logs.push(args);
  };

  try {
    const results = await client.search("memory");

    assert.deepEqual(results, []);
    assert.deepEqual(logs, [["OpenClaw not connected"]]);
  } finally {
    console.log = originalLog;
  }
});

test("OpenClawClient.ingest returns queued with a generated id", async () => {
  const client = new OpenClawClient({
    enabled: true,
    apiUrl: "https://openclaw.example",
    apiKey: "test-key"
  });

  const result = await client.ingest("hello world", { source: "test" });

  assert.equal(result.status, "queued");
  assert.match(result.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("OpenClawClient.isConfigured requires enabled mode and credentials", () => {
  assert.equal(new OpenClawClient({ enabled: false }).isConfigured(), false);
  assert.equal(
    new OpenClawClient({
      enabled: true,
      apiUrl: "https://openclaw.example"
    }).isConfigured(),
    false
  );
  assert.equal(
    new OpenClawClient({
      enabled: true,
      apiKey: "test-key"
    }).isConfigured(),
    false
  );
  assert.equal(
    new OpenClawClient({
      enabled: true,
      apiUrl: "https://openclaw.example",
      apiKey: "test-key"
    }).isConfigured(),
    true
  );
});

test("OpenClawClient stays unconfigured in disabled mode even with credentials", async () => {
  const client = new OpenClawClient({
    enabled: false,
    apiUrl: "https://openclaw.example",
    apiKey: "test-key"
  });

  assert.equal(client.isConfigured(), false);
  assert.deepEqual(await client.search("disabled"), []);
  assert.equal(await client.getDocument("doc-1"), null);
});
