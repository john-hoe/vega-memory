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

test("OpenClawClient uses the remote API when configured", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new OpenClawClient({
    enabled: true,
    apiUrl: "https://openclaw.example",
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/search")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "doc-1",
                title: "Doc 1",
                snippet: "snippet",
                score: 0.9,
                source: "openclaw"
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (String(url).includes("/documents/")) {
        return new Response(
          JSON.stringify({
            document: {
              id: "doc-1",
              title: "Doc 1",
              content: "body",
              metadata: { source: "openclaw" },
              createdAt: "2026-04-08T00:00:00.000Z"
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          id: "ingest-1",
          status: "queued"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });

  const results = await client.search("hello", { limit: 3 });
  const document = await client.getDocument("doc-1");
  const ingest = await client.ingest("hello world", { source: "test" });

  assert.equal(results[0]?.id, "doc-1");
  assert.equal(document?.id, "doc-1");
  assert.equal(ingest.id, "ingest-1");
  assert.equal(ingest.status, "queued");
  assert.match(String(requests[0]?.url), /\/search$/);
  assert.match(String(requests[1]?.url), /\/documents\/doc-1$/);
  assert.match(String(requests[2]?.url), /\/ingest$/);
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
