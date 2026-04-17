import assert from "node:assert/strict";
import test from "node:test";

import { v5 as uuidv5 } from "uuid";

import { VEGA_BACKFILL_NAMESPACE } from "../ingestion/raw-inbox-backfill.js";
import { memoryToEnvelope } from "../ingestion/memory-to-envelope.js";
import type { Memory } from "../core/types.js";

const NOW = "2026-04-17T00:00:00.000Z";

function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: null,
    type: "decision",
    project: "vega-memory",
    title: "Title",
    content: "Content",
    summary: "Summary",
    embedding: null,
    importance: 0.8,
    source: "explicit",
    tags: ["phase-8"],
    created_at: NOW,
    updated_at: NOW,
    accessed_at: NOW,
    access_count: 0,
    status: "active",
    verified: "unverified",
    scope: "project",
    accessed_projects: ["vega-memory"],
    source_context: {
      actor: "tester",
      channel: "cli",
      device_id: "device-1",
      device_name: "Mac",
      platform: "darwin",
      session_id: "session-1"
    },
    ...overrides
  };
}

test("memoryToEnvelope uses a UUID memory id as the envelope event_id", () => {
  const envelope = memoryToEnvelope(createMemory());

  assert.equal(envelope.event_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(envelope.session_id, "session-1");
  assert.deepEqual(envelope.payload, {
    memory_type: "decision",
    title: "Title",
    content: "Content",
    summary: "Summary",
    tags: ["phase-8"]
  });
});

test("memoryToEnvelope derives a deterministic UUID v5 for legacy non-uuid memory ids", () => {
  const createdAt = "2026-04-17T00:04:00.000Z";
  const envelope = memoryToEnvelope({
    id: "legacy-abc",
    type: "decision",
    project: "vega-memory",
    title: "Legacy Memory",
    content: "Legacy Content",
    summary: "Legacy Summary",
    tags: JSON.stringify(["phase-8", "legacy"]),
    created_at: createdAt,
    source_context: JSON.stringify({ session_id: "session-legacy" })
  });

  assert.equal(envelope.event_id, uuidv5(`legacy-abc:${createdAt}`, VEGA_BACKFILL_NAMESPACE));
  assert.equal(envelope.session_id, "session-legacy");
  assert.deepEqual(envelope.payload, {
    memory_type: "decision",
    title: "Legacy Memory",
    content: "Legacy Content",
    summary: "Legacy Summary",
    tags: ["phase-8", "legacy"]
  });
});

test("memoryToEnvelope applies default_surface when provided", () => {
  const envelope = memoryToEnvelope(createMemory(), {
    default_surface: "cli"
  });

  assert.equal(envelope.surface, "cli");
});

test("memoryToEnvelope force_event_id overrides the derived event id", () => {
  const envelope = memoryToEnvelope(createMemory({ id: "legacy-id" }), {
    force_event_id: "33333333-3333-4333-8333-333333333333"
  });

  assert.equal(envelope.event_id, "33333333-3333-4333-8333-333333333333");
});
