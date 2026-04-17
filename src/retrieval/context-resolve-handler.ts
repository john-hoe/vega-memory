import type { Request, Response } from "express";

import { INTENTS, MODES, SURFACES } from "../core/contracts/enums.js";
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

const CONTEXT_RESOLVE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: [...INTENTS] },
    mode: { type: "string", enum: [...MODES] },
    query: { type: "string" },
    surface: { type: "string", enum: [...SURFACES] },
    session_id: { type: "string" },
    project: { type: ["string", "null"] },
    cwd: { type: ["string", "null"] },
    budget_override: {
      type: "object",
      additionalProperties: false,
      properties: {
        tokens: { type: "number" },
        depth: { type: "number" }
      }
    },
    prev_checkpoint_id: { type: "string" }
  },
  required: ["intent", "surface", "session_id", "project", "cwd"]
} as const satisfies object;

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
