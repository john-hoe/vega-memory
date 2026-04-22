import assert from "node:assert";
import { describe, it } from "node:test";

import {
  parseEnvelope,
  safeParseEnvelope,
  safeParseTransportEnvelope,
  parseTransportEnvelope
} from "../core/contracts/envelope.js";
import { normalizeEnvelope } from "../ingestion/normalize-envelope.js";

const createEnvelope = (): Record<string, unknown> => ({
  schema_version: "1.0",
  event_id: "550e8400-e29b-41d4-a716-446655440000",
  surface: "claude",
  session_id: "session-1",
  thread_id: "thread-1",
  project: "vega-memory",
  cwd: "/Users/johnmacmini/workspace/vega-memory",
  host_timestamp: "2026-04-17T10:30:00.000Z",
  role: "user",
  event_type: "message",
  payload: {
    text: "hello"
  },
  safety: {
    redacted: false,
    categories: []
  },
  artifacts: [
    {
      id: "artifact-1",
      kind: "transcript",
      uri: "file:///tmp/artifact.txt",
      size_bytes: 128
    }
  ],
  source_kind: "vega_memory"
});

describe("HOST_EVENT_ENVELOPE_V1 (canonical)", () => {
  it("accepts a complete valid envelope", () => {
    const result = safeParseEnvelope(createEnvelope());

    assert.equal(result.success, true);
    if (!result.success) {
      assert.fail("expected safeParseEnvelope to succeed");
    }

    assert.equal(result.data.surface, "claude");
    assert.equal(result.data.source_kind, "vega_memory");
  });

  it("accepts nullable thread_id project and cwd", () => {
    const envelope = createEnvelope();
    envelope.thread_id = null;
    envelope.project = null;
    envelope.cwd = null;

    const parsed = parseEnvelope(envelope);

    assert.equal(parsed.thread_id, null);
    assert.equal(parsed.project, null);
    assert.equal(parsed.cwd, null);
  });

  it("rejects legacy surface names and accepts canonical ones", () => {
    const legacySurface = createEnvelope();
    legacySurface.surface = "claude-code";

    const legacyResult = safeParseEnvelope(legacySurface);
    const canonicalResult = safeParseEnvelope(createEnvelope());

    assert.equal(legacyResult.success, false);
    assert.equal(canonicalResult.success, true);
  });

  it("rejects a non-uuid event_id", () => {
    const envelope = createEnvelope();
    envelope.event_id = "not-a-uuid";

    const result = safeParseEnvelope(envelope);

    assert.equal(result.success, false);
  });

  it("allows missing source_kind but rejects non-canonical source_kind values", () => {
    const withoutSourceKind = createEnvelope();
    delete withoutSourceKind.source_kind;

    const missingResult = safeParseEnvelope(withoutSourceKind);

    const invalidSourceKind = createEnvelope();
    invalidSourceKind.source_kind = "external";

    const invalidResult = safeParseEnvelope(invalidSourceKind);

    assert.equal(missingResult.success, true);
    assert.equal(invalidResult.success, false);
  });
});

describe("HOST_EVENT_ENVELOPE_TRANSPORT_V1", () => {
  it("accepts free-string surface, role, and event_type", () => {
    const envelope = createEnvelope();
    envelope.surface = "claude-code";
    envelope.role = "developer";
    envelope.event_type = "custom_event";

    const result = safeParseTransportEnvelope(envelope);

    assert.equal(result.success, true);
    if (!result.success) {
      assert.fail("expected safeParseTransportEnvelope to succeed");
    }

    assert.equal(result.data.surface, "claude-code");
    assert.equal(result.data.role, "developer");
    assert.equal(result.data.event_type, "custom_event");
  });

  it("rejects a non-uuid event_id at transport level", () => {
    const envelope = createEnvelope();
    envelope.event_id = "not-a-uuid";

    const result = safeParseTransportEnvelope(envelope);

    assert.equal(result.success, false);
  });

  it("preserves source_kind validation at transport level", () => {
    const withoutSourceKind = createEnvelope();
    delete withoutSourceKind.source_kind;

    const missingResult = safeParseTransportEnvelope(withoutSourceKind);

    const invalidSourceKind = createEnvelope();
    invalidSourceKind.source_kind = "external";

    const invalidResult = safeParseTransportEnvelope(invalidSourceKind);

    assert.equal(missingResult.success, true);
    assert.equal(invalidResult.success, false);
  });
});

describe("normalizeEnvelope", () => {
  it("passes through canonical values unchanged", () => {
    const envelope = parseTransportEnvelope(createEnvelope());
    const normalized = normalizeEnvelope(envelope);

    assert.equal(normalized.surface, "claude");
    assert.equal(normalized.role, "user");
    assert.equal(normalized.event_type, "message");
    assert.equal(normalized.warnings.length, 0);
  });

  it("falls back unknown surface to 'unknown' with warning", () => {
    const envelope = parseTransportEnvelope({
      ...createEnvelope(),
      surface: "claude-code"
    });
    const normalized = normalizeEnvelope(envelope);

    assert.equal(normalized.surface, "unknown");
    assert.equal(normalized.warnings.length, 1);
    assert.ok(normalized.warnings[0]?.includes("claude-code"));
  });

  it("falls back unknown role to 'unknown' with warning", () => {
    const envelope = parseTransportEnvelope({
      ...createEnvelope(),
      role: "developer"
    });
    const normalized = normalizeEnvelope(envelope);

    assert.equal(normalized.role, "unknown");
    assert.equal(normalized.warnings.length, 1);
    assert.ok(normalized.warnings[0]?.includes("developer"));
  });

  it("falls back unknown event_type to 'unknown' with warning", () => {
    const envelope = parseTransportEnvelope({
      ...createEnvelope(),
      event_type: "custom_event"
    });
    const normalized = normalizeEnvelope(envelope);

    assert.equal(normalized.event_type, "unknown");
    assert.equal(normalized.warnings.length, 1);
    assert.ok(normalized.warnings[0]?.includes("custom_event"));
  });

  it("accumulates multiple warnings for multiple unknown fields", () => {
    const envelope = parseTransportEnvelope({
      ...createEnvelope(),
      surface: "claude-code",
      role: "developer",
      event_type: "custom_event"
    });
    const normalized = normalizeEnvelope(envelope);

    assert.equal(normalized.warnings.length, 3);
  });
});
