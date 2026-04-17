import type { Request, Response } from "express";
import { z } from "zod";

import { INTENT_REQUEST_SCHEMA } from "../core/contracts/intent.js";
import { createLogger } from "../core/logging/index.js";

import type { ContextResolveResponse, RetrievalOrchestrator } from "./orchestrator.js";

export interface ContextResolveMcpTool {
  name: "context.resolve";
  description: string;
  inputSchema: object;
  invoke(request: unknown): Promise<ContextResolveResponse>;
}

const logger = createLogger({ name: "context-resolve-handler" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeZodJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeZodJsonSchema(entry));
  }

  if (!isRecord(schema)) {
    return schema;
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === false) {
      continue;
    }

    normalized[key] = normalizeZodJsonSchema(value);
  }

  const properties = normalized.properties;

  if (Array.isArray(normalized.required) && isRecord(properties)) {
    normalized.required = normalized.required.filter((entry) => {
      if (typeof entry !== "string") {
        return false;
      }

      const propertySchema = properties[entry];
      return !isRecord(propertySchema) || !("default" in propertySchema);
    });
  }

  return normalized;
}

function createContextResolveInputSchema(): object {
  const generated = normalizeZodJsonSchema(z.toJSONSchema(INTENT_REQUEST_SCHEMA));

  if (!isRecord(generated)) {
    return {};
  }

  const properties = isRecord(generated.properties) ? { ...generated.properties } : {};
  const prevCheckpoint = isRecord(properties.prev_checkpoint_id) ? properties.prev_checkpoint_id : {};
  const allOf = Array.isArray(generated.allOf) ? [...generated.allOf] : [];

  properties.prev_checkpoint_id = {
    ...prevCheckpoint,
    description: "Required when intent is 'followup'."
  };

  allOf.push({
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
  });

  return {
    ...generated,
    properties,
    allOf
  };
}

const CONTEXT_RESOLVE_INPUT_SCHEMA = createContextResolveInputSchema();

const formatValidationDetail = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "root" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export function createContextResolveHttpHandler(
  orchestrator: RetrievalOrchestrator
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = INTENT_REQUEST_SCHEMA.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: "ValidationError",
          detail: formatValidationDetail(parsed.error.issues)
        });
        return;
      }

      res.status(200).json(orchestrator.resolve(parsed.data));
    } catch (error) {
      logger.error("context.resolve HTTP handler failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      res.status(500).json({ error: "InternalError" });
    }
  };
}

export function createContextResolveMcpTool(
  orchestrator: RetrievalOrchestrator
): ContextResolveMcpTool {
  return {
    name: "context.resolve",
    description: "Resolves retrieval context for an intent request and returns an assembled bundle.",
    inputSchema: CONTEXT_RESOLVE_INPUT_SCHEMA,
    async invoke(request: unknown): Promise<ContextResolveResponse> {
      const parsed = INTENT_REQUEST_SCHEMA.parse(request);
      return orchestrator.resolve(parsed);
    }
  };
}
