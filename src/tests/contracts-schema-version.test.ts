import assert from "node:assert";
import { describe, it } from "node:test";

import { createDefaultBundleDispatcher, createDefaultEnvelopeDispatcher } from "../core/contracts/schema-version.js";

const createValidEnvelope = (): Record<string, unknown> => ({
  schema_version: "1.0",
  event_id: "550e8400-e29b-41d4-a716-446655440000",
  surface: "codex",
  session_id: "session-1",
  thread_id: "thread-1",
  project: "vega-memory",
  cwd: "/Users/johnmacmini/workspace/vega-memory",
  host_timestamp: "2026-04-17T10:30:00.000Z",
  role: "assistant",
  event_type: "message",
  payload: {
    text: "hello"
  },
  safety: {
    redacted: false,
    categories: []
  },
  artifacts: [],
  source_kind: "vega_memory"
});

describe("schema version dispatcher", () => {
  it("dispatches a valid default envelope", () => {
    const dispatcher = createDefaultEnvelopeDispatcher();
    const input = createValidEnvelope();

    const result = dispatcher.dispatch(input);

    assert.equal(result.version, "1.0");
    assert.deepEqual(result.data, input);
  });

  it("throws on an unsupported schema_version", () => {
    const dispatcher = createDefaultEnvelopeDispatcher();

    assert.throws(
      () => dispatcher.dispatch({ ...createValidEnvelope(), schema_version: "999.0" }),
      /Unsupported schema_version: 999.0/
    );
  });

  it("throws when schema_version is missing", () => {
    const dispatcher = createDefaultEnvelopeDispatcher();
    const input = createValidEnvelope();
    delete input.schema_version;

    assert.throws(() => dispatcher.dispatch(input), /schema_version/);
  });

  it("safeDispatch returns a failure result for an invalid envelope", () => {
    const dispatcher = createDefaultEnvelopeDispatcher();
    const result = dispatcher.safeDispatch({
      ...createValidEnvelope(),
      event_id: "not-a-uuid"
    });

    assert.equal(result.success, false);
  });
});

describe("bundle schema version dispatcher", () => {
  it("dispatches a valid default bundle", () => {
    const dispatcher = createDefaultBundleDispatcher();
    const input = {
      schema_version: "1.0",
      bundle_digest: "bundle-1",
      sections: []
    };

    const result = dispatcher.dispatch(input);

    assert.equal(result.version, "1.0");
    assert.deepEqual(result.data, input);
  });

  it("throws when bundle schema_version is missing", () => {
    const dispatcher = createDefaultBundleDispatcher();

    assert.throws(
      () =>
        dispatcher.dispatch({
          bundle_digest: "bundle-1",
          sections: []
        }),
      /schema_version/
    );
  });
});
