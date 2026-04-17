import assert from "node:assert/strict";
import test from "node:test";

import { INTENT_REQUEST_SCHEMA } from "../core/contracts/intent.js";
import { createContextResolveMcpTool } from "../retrieval/context-resolve-handler.js";

type JsonSchema = boolean | Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "object":
      return isRecord(value);
    default:
      return true;
  }
}

function validateJsonSchema(schema: JsonSchema, value: unknown): boolean {
  if (typeof schema === "boolean") {
    return schema;
  }

  if (Array.isArray(schema.allOf) && !schema.allOf.every((entry) => validateJsonSchema(entry as JsonSchema, value))) {
    return false;
  }

  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((entry) => validateJsonSchema(entry as JsonSchema, value))) {
    return false;
  }

  if ("const" in schema && !Object.is(schema.const, value)) {
    return false;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    return false;
  }

  if (typeof schema.type === "string" && !matchesType(schema.type, value)) {
    return false;
  }

  if (
    Array.isArray(schema.type) &&
    !schema.type.some((entry) => typeof entry === "string" && matchesType(entry, value))
  ) {
    return false;
  }

  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    return false;
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required =
      Array.isArray(schema.required) && schema.required.every((entry) => typeof entry === "string")
        ? (schema.required as string[])
        : [];

    for (const key of required) {
      if (!(key in value)) {
        return false;
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          return false;
        }
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value && !validateJsonSchema(propertySchema as JsonSchema, value[key])) {
        return false;
      }
    }
  }

  if (isRecord(schema.if) && validateJsonSchema(schema.if, value)) {
    if (schema.then !== undefined && !validateJsonSchema(schema.then as JsonSchema, value)) {
      return false;
    }
  }

  return true;
}

function getInputSchema(): Record<string, unknown> {
  const tool = createContextResolveMcpTool({
    resolve() {
      throw new Error("resolve should not run in schema tests");
    }
  } as never);

  return tool.inputSchema as Record<string, unknown>;
}

test("context.resolve inputSchema stays aligned with INTENT_REQUEST_SCHEMA for core request samples", () => {
  const inputSchema = getInputSchema();
  const cases = [
    {
      name: "valid lookup with default mode",
      request: {
        intent: "lookup",
        query: "SQLite backup evidence",
        surface: "codex",
        session_id: "session-1",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory"
      }
    },
    {
      name: "invalid lookup with empty query",
      request: {
        intent: "lookup",
        query: "",
        surface: "codex",
        session_id: "session-1",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory"
      }
    },
    {
      name: "invalid followup without prev checkpoint",
      request: {
        intent: "followup",
        query: "checkpoint followup",
        surface: "codex",
        session_id: "session-1",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory"
      }
    },
    {
      name: "valid followup with prev checkpoint",
      request: {
        intent: "followup",
        query: "checkpoint followup",
        surface: "codex",
        session_id: "session-1",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory",
        prev_checkpoint_id: "checkpoint-1"
      }
    },
    {
      name: "budget_override extra depth matches parser behavior",
      request: {
        intent: "lookup",
        query: "SQLite backup evidence",
        surface: "codex",
        session_id: "session-1",
        project: "vega-memory",
        cwd: "/Users/johnmacmini/workspace/vega-memory",
        budget_override: {
          tokens: 8,
          depth: 3
        }
      }
    }
  ] as const;

  for (const testCase of cases) {
    assert.equal(
      validateJsonSchema(inputSchema, testCase.request),
      INTENT_REQUEST_SCHEMA.safeParse(testCase.request).success,
      testCase.name
    );
  }
});

test("context.resolve inputSchema exposes the current intent contract", () => {
  const inputSchema = getInputSchema();
  const properties = inputSchema.properties as Record<string, Record<string, unknown>>;
  const budgetOverride = properties.budget_override.properties as Record<string, unknown>;

  assert.deepEqual(properties.intent.enum, ["bootstrap", "lookup", "followup", "evidence"]);
  assert.deepEqual(properties.mode.enum, ["L0", "L1", "L2", "L3"]);
  assert.equal(properties.mode.default, "L1");
  assert.equal(properties.query.minLength, 1);
  assert.ok(!(inputSchema.required as string[]).includes("mode"));
  assert.ok(!(inputSchema.required as string[]).includes("prev_checkpoint_id"));
  assert.ok(!("depth" in budgetOverride));
  assert.deepEqual(inputSchema.allOf, [
    {
      if: {
        type: "object",
        properties: {
          intent: {
            const: "followup"
          }
        },
        required: ["intent"]
      },
      then: {
        required: ["prev_checkpoint_id"]
      }
    }
  ]);
});
