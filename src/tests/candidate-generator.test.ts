import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFromDecisionPayload,
  extractFromMessagePayload,
  extractFromStateChangePayload,
  extractFromToolCallPayload,
  extractFromToolResultPayload
} from "../ingestion/candidate-extractor.js";
import { envelopeToCandidateInput } from "../ingestion/candidate-generator.js";

test("extractFromMessagePayload extracts text and computes deterministic dedup key", () => {
  const result = extractFromMessagePayload({ text: "Hello world", project: "vega-memory" });

  assert.equal(result.content, "Hello world");
  assert.equal(result.type, "observation");
  assert.equal(result.project, "vega-memory");
  assert.equal(typeof result.raw_dedup_key, "string");
  assert.equal(result.raw_dedup_key.length, 64);
  assert.equal(typeof result.semantic_fingerprint, "string");
  assert.equal(result.semantic_fingerprint.length, 64);

  const same = extractFromMessagePayload({ text: "Hello world" });

  assert.equal(result.raw_dedup_key, same.raw_dedup_key);
  assert.equal(result.semantic_fingerprint, same.semantic_fingerprint);

  const different = extractFromMessagePayload({ text: "Goodbye world" });

  assert.notEqual(result.raw_dedup_key, different.raw_dedup_key);
  assert.notEqual(result.semantic_fingerprint, different.semantic_fingerprint);
});

test("extractFromMessagePayload falls back through content and message keys", () => {
  const fromContent = extractFromMessagePayload({ content: "via content" });
  const fromMessage = extractFromMessagePayload({ message: "via message" });

  assert.equal(fromContent.content, "via content");
  assert.equal(fromMessage.content, "via message");
});

test("extractFromToolResultPayload extracts result and includes tool name in dedup key", () => {
  const result = extractFromToolResultPayload({
    result: "output data",
    tool_name: "search",
    project: "vega-memory"
  });

  assert.equal(result.content, "output data");
  assert.equal(result.type, "insight");
  assert.equal(result.project, "vega-memory");
  assert.equal(typeof result.raw_dedup_key, "string");
  assert.equal(result.raw_dedup_key.length, 64);
  assert.equal(typeof result.semantic_fingerprint, "string");
  assert.equal(result.semantic_fingerprint.length, 64);

  const same = extractFromToolResultPayload({ result: "output data", tool_name: "search" });

  assert.equal(result.raw_dedup_key, same.raw_dedup_key);
  assert.equal(result.semantic_fingerprint, same.semantic_fingerprint);
});

test("extractFromDecisionPayload extracts decision text", () => {
  const result = extractFromDecisionPayload({
    decision: "Use SQLite for local storage",
    project: "vega-memory"
  });

  assert.equal(result.content, "Use SQLite for local storage");
  assert.equal(result.type, "decision");
  assert.equal(result.project, "vega-memory");
  assert.equal(typeof result.raw_dedup_key, "string");
  assert.equal(result.raw_dedup_key.length, 64);
  assert.equal(typeof result.semantic_fingerprint, "string");
  assert.equal(result.semantic_fingerprint.length, 64);
});

test("extractFromStateChangePayload extracts description", () => {
  const result = extractFromStateChangePayload({
    description: "Added new field to schema",
    project: "vega-memory"
  });

  assert.equal(result.content, "Added new field to schema");
  assert.equal(result.type, "project_context");
  assert.equal(result.project, "vega-memory");
  assert.equal(typeof result.raw_dedup_key, "string");
  assert.equal(result.raw_dedup_key.length, 64);
  assert.equal(typeof result.semantic_fingerprint, "string");
  assert.equal(result.semantic_fingerprint.length, 64);
});

test("extractFromToolCallPayload extracts arguments and tool name", () => {
  const result = extractFromToolCallPayload({
    arguments: '{"query": "test"}',
    tool_name: "search",
    project: "vega-memory"
  });

  assert.equal(result.content, '{"query": "test"}');
  assert.equal(result.type, "insight");
  assert.equal(result.project, "vega-memory");
  assert.equal(typeof result.raw_dedup_key, "string");
  assert.equal(result.raw_dedup_key.length, 64);
  assert.equal(typeof result.semantic_fingerprint, "string");
  assert.equal(result.semantic_fingerprint.length, 64);
});

test("envelopeToCandidateInput maps known event types to candidate inputs", () => {
  const envelope = {
    schema_version: "1.0" as const,
    event_id: "550e8400-e29b-41d4-a716-446655440000",
    surface: "claude",
    session_id: "session-1",
    thread_id: null,
    project: "vega-memory",
    cwd: "/workspace",
    host_timestamp: "2026-04-22T10:00:00Z",
    role: "user",
    event_type: "message",
    payload: { text: "Hello world" },
    safety: { redacted: false, categories: [] },
    artifacts: []
  };

  const result = envelopeToCandidateInput(envelope);

  assert.equal(result.skipped_reason, undefined);
  assert.equal(result.input.content, "Hello world");
  assert.equal(result.input.type, "observation");
  assert.equal(result.input.project, "vega-memory");
  assert.equal(typeof result.input.raw_dedup_key, "string");
  assert.equal(result.input.raw_dedup_key?.length, 64);
  assert.equal(typeof result.input.semantic_fingerprint, "string");
  assert.equal(result.input.semantic_fingerprint?.length, 64);
  assert.ok(result.input.extraction_source.includes("claude"));
  assert.ok(result.input.extraction_source.includes("message"));
});

test("envelopeToCandidateInput falls back for unknown event types", () => {
  const envelope = {
    schema_version: "1.0" as const,
    event_id: "550e8400-e29b-41d4-a716-446655440000",
    surface: "claude",
    session_id: "session-1",
    thread_id: null,
    project: "vega-memory",
    cwd: "/workspace",
    host_timestamp: "2026-04-22T10:00:00Z",
    role: "user",
    event_type: "custom_event",
    payload: { foo: "bar" },
    safety: { redacted: false, categories: [] },
    artifacts: []
  };

  const result = envelopeToCandidateInput(envelope);

  assert.equal(result.skipped_reason, 'No extractor for event_type "custom_event"; falling back to raw JSON content with no dedup key');
  assert.equal(result.input.content, '{"foo":"bar"}');
  assert.equal(result.input.type, "unknown");
  assert.equal(result.input.raw_dedup_key, null);
  assert.equal(result.input.semantic_fingerprint, null);
});

test("envelopeToCandidateInput skips empty extracted content", () => {
  const envelope = {
    schema_version: "1.0" as const,
    event_id: "550e8400-e29b-41d4-a716-446655440000",
    surface: "claude",
    session_id: "session-1",
    thread_id: null,
    project: "vega-memory",
    cwd: "/workspace",
    host_timestamp: "2026-04-22T10:00:00Z",
    role: "user",
    event_type: "message",
    payload: { text: "" },
    safety: { redacted: false, categories: [] },
    artifacts: []
  };

  const result = envelopeToCandidateInput(envelope);

  assert.equal(result.skipped_reason, "Empty content after extraction; no dedup key generated");
  assert.equal(result.input.content, "");
  assert.equal(result.input.raw_dedup_key, null);
  assert.equal(result.input.semantic_fingerprint, null);
});

test("deterministic dedup keys are stable across repeated extraction", () => {
  const payload = { text: "Stable content", project: "vega-memory" };
  const first = extractFromMessagePayload(payload);
  const second = extractFromMessagePayload(payload);

  assert.equal(first.raw_dedup_key, second.raw_dedup_key);
  assert.equal(first.semantic_fingerprint, second.semantic_fingerprint);
});

test("semantic fingerprint normalizes case and punctuation differences", () => {
  const a = extractFromMessagePayload({ text: "Hello, World!" });
  const b = extractFromMessagePayload({ text: "hello world" });

  assert.notEqual(a.raw_dedup_key, b.raw_dedup_key);
  assert.equal(a.semantic_fingerprint, b.semantic_fingerprint);
});

test("semantic fingerprint collapses whitespace", () => {
  const a = extractFromMessagePayload({ text: "hello   world" });
  const b = extractFromMessagePayload({ text: "hello world" });

  assert.notEqual(a.raw_dedup_key, b.raw_dedup_key);
  assert.equal(a.semantic_fingerprint, b.semantic_fingerprint);
});

test("semantic fingerprint is still sensitive to meaningful content changes", () => {
  const a = extractFromMessagePayload({ text: "hello world" });
  const b = extractFromMessagePayload({ text: "hello universe" });

  assert.notEqual(a.raw_dedup_key, b.raw_dedup_key);
  assert.notEqual(a.semantic_fingerprint, b.semantic_fingerprint);
});
