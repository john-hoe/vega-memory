import assert from "node:assert/strict";
import test from "node:test";

import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import { SQLiteAdapter } from "../db/sqlite-adapter.js";
import { createIngestEventHttpHandler, createIngestEventMcpTool } from "../ingestion/ingest-event-handler.js";
import { applyRawInboxMigration } from "../ingestion/raw-inbox.js";

const createEnvelope = (overrides: Partial<HostEventEnvelopeV1> = {}): HostEventEnvelopeV1 => ({
  schema_version: "1.0",
  event_id: "11111111-1111-4111-8111-111111111111",
  surface: "codex",
  session_id: "session-1",
  thread_id: "thread-1",
  project: "vega-memory",
  cwd: "/workspace/vega-memory",
  host_timestamp: "2026-04-17T00:00:00.000Z",
  role: "assistant",
  event_type: "message",
  payload: { text: "hello" },
  safety: { redacted: false, categories: [] },
  artifacts: [],
  source_kind: "vega_memory",
  ...overrides
});

interface StubResponse {
  statusCode: number;
  body: unknown;
  status(code: number): StubResponse;
  json(payload: unknown): StubResponse;
}

const createResponse = (): StubResponse => ({
  statusCode: 200,
  body: undefined,
  status(code: number) {
    this.statusCode = code;
    return this;
  },
  json(payload: unknown) {
    this.body = payload;
    return this;
  }
});

test("HTTP handler returns 200 and stages a valid envelope in raw_inbox", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const handler = createIngestEventHttpHandler(db);
    const response = createResponse();

    await handler({ body: createEnvelope() } as never, response as never);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      accepted_event_id: "11111111-1111-4111-8111-111111111111",
      staged_in: "raw_inbox"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler returns deduped on a repeated event_id", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const handler = createIngestEventHttpHandler(db);
    const envelope = createEnvelope();

    await handler({ body: envelope } as never, createResponse() as never);

    const secondResponse = createResponse();
    await handler({ body: envelope } as never, secondResponse as never);

    assert.equal(secondResponse.statusCode, 200);
    assert.deepEqual(secondResponse.body, {
      accepted_event_id: "11111111-1111-4111-8111-111111111111",
      staged_in: "deduped"
    });
  } finally {
    db.close();
  }
});

test("HTTP handler accepts non-canonical surface, role, and event_type", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const handler = createIngestEventHttpHandler(db);
    const response = createResponse();

    await handler(
      {
        body: {
          ...createEnvelope(),
          event_id: "77777777-7777-4777-8777-777777777777",
          surface: "claude-code",
          role: "developer",
          event_type: "custom_event"
        }
      } as never,
      response as never
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      accepted_event_id: "77777777-7777-4777-8777-777777777777",
      staged_in: "raw_inbox"
    });
  } finally {
    db.close();
  }
});

test("MCP tool invoke returns IngestEventResponse for a valid envelope", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const tool = createIngestEventMcpTool(db);
    const result = await tool.invoke(createEnvelope());

    assert.deepEqual(result, {
      accepted_event_id: "11111111-1111-4111-8111-111111111111",
      staged_in: "raw_inbox"
    });
  } finally {
    db.close();
  }
});

test("MCP tool invoke accepts non-canonical surface, role, and event_type", async () => {
  const db = new SQLiteAdapter(":memory:");

  try {
    applyRawInboxMigration(db);

    const tool = createIngestEventMcpTool(db);
    const result = await tool.invoke({
      ...createEnvelope(),
      event_id: "88888888-8888-4888-8888-888888888888",
      surface: "claude-code",
      role: "developer",
      event_type: "custom_event"
    });

    assert.deepEqual(result, {
      accepted_event_id: "88888888-8888-4888-8888-888888888888",
      staged_in: "raw_inbox"
    });
  } finally {
    db.close();
  }
});
