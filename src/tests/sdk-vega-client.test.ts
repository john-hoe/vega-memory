import assert from "node:assert/strict";
import test from "node:test";

import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import type { IntentRequest } from "../core/contracts/intent.js";
import type { UsageAck } from "../core/contracts/usage-ack.js";
import { VegaClient, VegaClientError } from "../sdk/vega-client.js";

const createClient = () =>
  new VegaClient({
    baseUrl: "https://vega.example",
    apiKey: "secret"
  });

const withFetchStub = async (
  handler: typeof fetch,
  run: () => Promise<void>
): Promise<void> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const createEnvelope = (): HostEventEnvelopeV1 => ({
  schema_version: "1.0",
  event_id: "550e8400-e29b-41d4-a716-446655440000",
  surface: "claude",
  session_id: "session-1",
  thread_id: "thread-1",
  project: "vega-memory",
  cwd: "/Users/johnmacmini/workspace/vega-memory",
  host_timestamp: "2026-04-21T08:00:00.000Z",
  role: "user",
  event_type: "message",
  payload: { text: "hello" },
  safety: { redacted: false, categories: [] },
  artifacts: []
});

const createIntent = (): IntentRequest => ({
  intent: "lookup",
  mode: "L1",
  query: "adapter guide",
  surface: "cursor",
  session_id: "session-1",
  project: "vega-memory",
  cwd: "/Users/johnmacmini/workspace/vega-memory"
});

const createAck = (): UsageAck => ({
  checkpoint_id: "checkpoint-1",
  bundle_digest: "bundle-1",
  sufficiency: "sufficient",
  host_tier: "T2"
});

test("VegaClient.ingestEvent posts envelopes and returns the accepted event response", async () => {
  await withFetchStub((async (input, init) => {
    assert.equal(String(input), "https://vega.example/ingest_event");
    assert.equal(init?.headers instanceof Headers, true);
    assert.equal((init?.headers as Headers).get("authorization"), "Bearer secret");
    assert.deepEqual(JSON.parse(String(init?.body)), createEnvelope());
    return new Response(JSON.stringify({ accepted_event_id: "evt-1", staged_in: "raw_inbox" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch, async () => {
    const result = await createClient().ingestEvent(createEnvelope());
    assert.deepEqual(result, { accepted_event_id: "evt-1", staged_in: "raw_inbox" });
  });
});

test("VegaClient.contextResolve posts intent requests and returns bundles", async () => {
  await withFetchStub((async (input, init) => {
    assert.equal(String(input), "https://vega.example/context_resolve");
    assert.deepEqual(JSON.parse(String(init?.body)), createIntent());
    return new Response(
      JSON.stringify({
        checkpoint_id: "checkpoint-1",
        bundle_digest: "bundle-1",
        bundle: { schema_version: "1.0", bundle_digest: "bundle-1", sections: [] },
        profile_used: "lookup",
        ranker_version: "v1.0"
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  }) as typeof fetch, async () => {
    const result = await createClient().contextResolve(createIntent());
    assert.equal(result.checkpoint_id, "checkpoint-1");
    assert.equal(result.bundle.bundle_digest, "bundle-1");
  });
});

test("VegaClient.usageAck posts usage acknowledgements and returns ack responses", async () => {
  await withFetchStub((async (input, init) => {
    assert.equal(String(input), "https://vega.example/usage_ack");
    assert.deepEqual(JSON.parse(String(init?.body)), createAck());
    return new Response(JSON.stringify({ ack: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch, async () => {
    const result = await createClient().usageAck(createAck());
    assert.deepEqual(result, { ack: true });
  });
});

test("VegaClient retries 5xx responses and returns the first later success", async () => {
  let attempts = 0;

  await withFetchStub((async () => {
    attempts += 1;
    return attempts < 3
      ? new Response(JSON.stringify({ error: "retry" }), { status: 503 })
      : new Response(JSON.stringify({ ack: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
  }) as typeof fetch, async () => {
    const result = await createClient().usageAck(createAck());
    assert.deepEqual(result, { ack: true });
    assert.equal(attempts, 3);
  });
});

test("VegaClient throws a structured error after retry exhaustion", async () => {
  let attempts = 0;

  await withFetchStub((async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: "down" }), { status: 503, statusText: "Down" });
  }) as typeof fetch, async () => {
    await assert.rejects(() => createClient().usageAck(createAck()), (error: unknown) => {
      assert.equal(error instanceof VegaClientError, true);
      assert.equal((error as VegaClientError).status, 503);
      assert.match((error as VegaClientError).message, /503/);
      return true;
    });
    assert.equal(attempts, 4);
  });
});

test("VegaClient does not retry 4xx responses", async () => {
  let attempts = 0;

  await withFetchStub((async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: "ValidationError", detail: "bad input" }), {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch, async () => {
    await assert.rejects(() => createClient().ingestEvent(createEnvelope()), (error: unknown) => {
      assert.equal(error instanceof VegaClientError, true);
      assert.equal((error as VegaClientError).status, 400);
      assert.equal((error as VegaClientError).detail, "bad input");
      return true;
    });
    assert.equal(attempts, 1);
  });
});
