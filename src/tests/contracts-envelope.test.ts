import assert from "node:assert";
import { describe, it } from "node:test";

import { parseEnvelope, safeParseEnvelope } from "../core/contracts/envelope.js";

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

describe("HOST_EVENT_ENVELOPE_V1", () => {
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
