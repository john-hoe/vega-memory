import assert from "node:assert";
import { describe, it } from "node:test";

import { createEnvelopeBuilder } from "../core/contracts/envelope-builder.js";
import { validateTransportEnvelope, isValidTransportEnvelope } from "../core/contracts/envelope-validator.js";

describe("host-sdk integration — multi-surface transport contract", () => {
  it("claude surface: builds and validates a user message envelope", () => {
    const envelope = createEnvelopeBuilder({
      surface: "claude",
      session_id: "claude-session-001",
      role: "user",
      event_type: "message",
      project: "vega-memory",
      cwd: "/workspace/vega-memory"
    })
      .setPayload({ content: "Hello from Claude Code" })
      .build();

    const result = validateTransportEnvelope(envelope);
    assert.equal(result.valid, true);
    assert.equal(envelope.surface, "claude");
    assert.equal(isValidTransportEnvelope(envelope), true);
  });

  it("cursor surface: builds and validates an assistant tool_call envelope", () => {
    const envelope = createEnvelopeBuilder({
      surface: "cursor",
      session_id: "cursor-session-042",
      role: "assistant",
      event_type: "tool_call",
      thread_id: "thread-cursor-7"
    })
      .setPayload({ tool: "read_file", path: "/src/index.ts" })
      .setSafety({ redacted: false, categories: [] })
      .build();

    const result = validateTransportEnvelope(envelope);
    assert.equal(result.valid, true);
    assert.equal(envelope.surface, "cursor");
    assert.equal(envelope.thread_id, "thread-cursor-7");
    assert.equal(isValidTransportEnvelope(envelope), true);
  });

  it("opencode surface: builds and validates a system state_change envelope", () => {
    const envelope = createEnvelopeBuilder({
      surface: "api",
      session_id: "opencode-session-99",
      role: "system",
      event_type: "state_change",
      project: "vega-memory",
      cwd: "/workspace/vega-memory"
    })
      .setPayload({ status: "ready", worker_id: "worker-1" })
      .setArtifacts([{ id: "art-1", kind: "log", uri: "file:///tmp/worker.log", size_bytes: 1024 }])
      .build();

    const result = validateTransportEnvelope(envelope);
    assert.equal(result.valid, true);
    assert.equal(envelope.surface, "api");
    assert.equal(envelope.artifacts.length, 1);
    assert.equal(isValidTransportEnvelope(envelope), true);
  });

  it("rejects a claude envelope with missing session_id", () => {
    const partial = {
      schema_version: "1.0",
      event_id: "550e8400-e29b-41d4-a716-446655440000",
      surface: "claude",
      role: "user",
      event_type: "message",
      host_timestamp: new Date().toISOString(),
      payload: {},
      safety: { redacted: false, categories: [] },
      artifacts: []
    };

    const result = validateTransportEnvelope(partial);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("session_id")));
    assert.equal(isValidTransportEnvelope(partial), false);
  });

  it("rejects a cursor envelope with invalid payload type", () => {
    const envelope = createEnvelopeBuilder({
      surface: "cursor",
      session_id: "cursor-session-042",
      role: "assistant",
      event_type: "tool_call"
    }).build();

    const bad = { ...envelope, payload: "not-an-object" };
    const result = validateTransportEnvelope(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("payload")));
    assert.equal(isValidTransportEnvelope(bad), false);
  });

  it("rejects an opencode envelope with non-uuid event_id", () => {
    const envelope = createEnvelopeBuilder({
      surface: "api",
      session_id: "opencode-session-99",
      role: "system",
      event_type: "state_change"
    }).build();

    const bad = { ...envelope, event_id: "not-a-uuid" };
    const result = validateTransportEnvelope(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("event_id")));
    assert.equal(isValidTransportEnvelope(bad), false);
  });

  it("accepts free-string surface, role, and event_type across all hosts", () => {
    const hosts = [
      { surface: "claude", role: "developer", event_type: "custom_event" },
      { surface: "cursor", role: "reviewer", event_type: "pr_opened" },
      { surface: "api", role: "orchestrator", event_type: "dispatch" }
    ];

    for (const h of hosts) {
      const envelope = createEnvelopeBuilder({
        surface: h.surface,
        session_id: "session-1",
        role: h.role,
        event_type: h.event_type
      }).build();

      const result = validateTransportEnvelope(envelope);
      assert.equal(result.valid, true, `expected valid for surface=${h.surface}`);
      assert.equal(isValidTransportEnvelope(envelope), true);
    }
  });

  it("host thin contract: envelope has no host-side intelligence fields", () => {
    const envelope = createEnvelopeBuilder({
      surface: "claude",
      session_id: "session-1",
      role: "user",
      event_type: "message"
    }).build();

    assert.equal("embedding" in envelope, false);
    assert.equal("semantic_tags" in envelope, false);
    assert.equal("promotion_score" in envelope, false);
    assert.equal("retrieval_rank" in envelope, false);
  });
});
