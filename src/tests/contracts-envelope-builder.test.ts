import assert from "node:assert";
import { describe, it } from "node:test";

import { createEnvelopeBuilder } from "../core/contracts/envelope-builder.js";
import { validateTransportEnvelope, isValidTransportEnvelope } from "../core/contracts/envelope-validator.js";

describe("createEnvelopeBuilder", () => {
  it("builds a minimal envelope with defaults", () => {
    const envelope = createEnvelopeBuilder({
      surface: "claude",
      session_id: "session-1",
      role: "user",
      event_type: "message"
    }).build();

    assert.equal(envelope.schema_version, "1.0");
    assert.match(envelope.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(envelope.surface, "claude");
    assert.equal(envelope.session_id, "session-1");
    assert.equal(envelope.thread_id, null);
    assert.equal(envelope.project, null);
    assert.equal(envelope.cwd, null);
    assert.ok(envelope.host_timestamp);
    assert.equal(envelope.role, "user");
    assert.equal(envelope.event_type, "message");
    assert.deepEqual(envelope.payload, {});
    assert.equal(envelope.safety.redacted, false);
    assert.deepEqual(envelope.safety.categories, []);
    assert.deepEqual(envelope.artifacts, []);
    assert.equal(envelope.source_kind, undefined);
  });

  it("allows setting payload, safety, and artifacts", () => {
    const envelope = createEnvelopeBuilder({
      surface: "cursor",
      session_id: "session-2",
      role: "assistant",
      event_type: "tool_call",
      thread_id: "thread-1",
      project: "vega-memory",
      cwd: "/tmp"
    })
      .setPayload({ tool: "read_file", path: "/tmp/test.txt" })
      .setSafety({ redacted: true, categories: ["secret"] })
      .setArtifacts([{ id: "art-1", kind: "file", uri: "file:///tmp/test.txt", size_bytes: 42 }])
      .build();

    assert.equal(envelope.surface, "cursor");
    assert.equal(envelope.session_id, "session-2");
    assert.equal(envelope.thread_id, "thread-1");
    assert.equal(envelope.project, "vega-memory");
    assert.equal(envelope.cwd, "/tmp");
    assert.equal(envelope.role, "assistant");
    assert.equal(envelope.event_type, "tool_call");
    assert.deepEqual(envelope.payload, { tool: "read_file", path: "/tmp/test.txt" });
    assert.equal(envelope.safety.redacted, true);
    assert.deepEqual(envelope.safety.categories, ["secret"]);
    assert.equal(envelope.artifacts.length, 1);
    assert.equal(envelope.artifacts[0]?.id, "art-1");
  });

  it("generates unique event_id per build", () => {
    const builder = createEnvelopeBuilder({
      surface: "api",
      session_id: "s1",
      role: "system",
      event_type: "state_change"
    });

    const a = builder.build();
    const b = builder.build();

    assert.notEqual(a.event_id, b.event_id);
  });

  it("generates timestamps close to now", () => {
    const before = Date.now();
    const envelope = createEnvelopeBuilder({
      surface: "cli",
      session_id: "s1",
      role: "user",
      event_type: "message"
    }).build();
    const after = Date.now();

    const ts = new Date(envelope.host_timestamp).getTime();
    assert.ok(ts >= before - 1000);
    assert.ok(ts <= after + 1000);
  });
});

describe("validateTransportEnvelope", () => {
  it("accepts a valid transport envelope", () => {
    const envelope = createEnvelopeBuilder({
      surface: "claude",
      session_id: "session-1",
      role: "user",
      event_type: "message"
    }).build();

    const result = validateTransportEnvelope(envelope);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("rejects missing required fields", () => {
    const result = validateTransportEnvelope({
      schema_version: "1.0",
      event_id: "550e8400-e29b-41d4-a716-446655440000",
      surface: "claude"
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("rejects non-uuid event_id", () => {
    const envelope = createEnvelopeBuilder({
      surface: "claude",
      session_id: "session-1",
      role: "user",
      event_type: "message"
    }).build();

    const bad = { ...envelope, event_id: "not-a-uuid" };
    const result = validateTransportEnvelope(bad);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("event_id")));
  });

  it("rejects invalid timestamp", () => {
    const envelope = createEnvelopeBuilder({
      surface: "claude",
      session_id: "session-1",
      role: "user",
      event_type: "message"
    }).build();

    const bad = { ...envelope, host_timestamp: "yesterday" };
    const result = validateTransportEnvelope(bad);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("host_timestamp")));
  });

  it("rejects non-object payload", () => {
    const envelope = createEnvelopeBuilder({
      surface: "claude",
      session_id: "session-1",
      role: "user",
      event_type: "message"
    }).build();

    const bad = { ...envelope, payload: "not-an-object" };
    const result = validateTransportEnvelope(bad);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("payload")));
  });

  it("accepts free-string surface, role, and event_type", () => {
    const envelope = createEnvelopeBuilder({
      surface: "my-custom-surface",
      session_id: "session-1",
      role: "developer",
      event_type: "custom_event"
    }).build();

    const result = validateTransportEnvelope(envelope);
    assert.equal(result.valid, true);
  });
});

describe("isValidTransportEnvelope", () => {
  it("returns true for a valid envelope", () => {
    const envelope = createEnvelopeBuilder({
      surface: "claude",
      session_id: "session-1",
      role: "user",
      event_type: "message"
    }).build();

    assert.equal(isValidTransportEnvelope(envelope), true);
  });

  it("returns false for invalid input", () => {
    assert.equal(isValidTransportEnvelope(null), false);
    assert.equal(isValidTransportEnvelope({}), false);
    assert.equal(isValidTransportEnvelope("string"), false);
  });
});
