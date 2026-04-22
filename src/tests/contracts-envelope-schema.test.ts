import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const schemaPath = join(__dirname, "../../docs/specs/host-event-envelope-v1.schema.json");

describe("host-event-envelope-v1.schema.json", () => {
  it("exists and is valid JSON", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const parsed = JSON.parse(raw);

    assert.equal(typeof parsed, "object");
    assert.ok(parsed !== null);
  });

  it("declares the correct $schema and $id", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
    assert.ok(schema.$id.includes("host-event-envelope-v1.schema.json"));
  });

  it("has all required top-level fields", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    const expected = [
      "schema_version",
      "event_id",
      "surface",
      "session_id",
      "thread_id",
      "project",
      "cwd",
      "host_timestamp",
      "role",
      "event_type",
      "payload",
      "safety",
      "artifacts"
    ];

    assert.deepEqual(schema.required, expected);
  });

  it("schema_version is a const '1.0'", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    assert.equal(schema.properties.schema_version.const, "1.0");
  });

  it("event_id has uuid format", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    assert.equal(schema.properties.event_id.format, "uuid");
  });

  it("host_timestamp has date-time format", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    assert.equal(schema.properties.host_timestamp.format, "date-time");
  });

  it("thread_id, project, cwd accept string or null", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    for (const key of ["thread_id", "project", "cwd"]) {
      const types = schema.properties[key].type;
      assert.ok(Array.isArray(types), `${key} should accept multiple types`);
      assert.ok(types.includes("string"), `${key} should accept string`);
      assert.ok(types.includes("null"), `${key} should accept null`);
    }
  });

  it("safety references EnvelopeSafety definition", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    assert.equal(schema.properties.safety.$ref, "#/definitions/EnvelopeSafety");
  });

  it("artifacts is an array of EnvelopeArtifact", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    assert.equal(schema.properties.artifacts.type, "array");
    assert.equal(schema.properties.artifacts.items.$ref, "#/definitions/EnvelopeArtifact");
  });

  it("source_kind is optional and has canonical enum values", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    assert.ok(!schema.required.includes("source_kind"), "source_kind should not be required");
    assert.ok(Array.isArray(schema.properties.source_kind.enum));
    assert.ok(schema.properties.source_kind.enum.includes("vega_memory"));
    assert.ok(schema.properties.source_kind.enum.includes("host_memory_file"));
  });

  it("EnvelopeSafety requires redacted and categories", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    const safety = schema.definitions.EnvelopeSafety;
    assert.deepEqual(safety.required, ["redacted", "categories"]);
    assert.equal(safety.properties.redacted.type, "boolean");
    assert.equal(safety.properties.categories.type, "array");
    assert.equal(safety.properties.categories.items.type, "string");
  });

  it("EnvelopeArtifact requires id and kind with optional uri and size_bytes", () => {
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);

    const artifact = schema.definitions.EnvelopeArtifact;
    assert.deepEqual(artifact.required, ["id", "kind"]);
    assert.equal(artifact.properties.id.type, "string");
    assert.equal(artifact.properties.kind.type, "string");
    assert.equal(artifact.properties.uri.type, "string");
    assert.equal(artifact.properties.size_bytes.type, "number");
  });
});
