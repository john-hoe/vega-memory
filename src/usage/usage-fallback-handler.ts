import type { Request, Response } from "express";
import { z } from "zod";

import {
  EXTERNAL_SOURCES,
  LOCAL_STOP_CONDITIONS,
  LOCAL_WORKSPACE_SOURCES,
  EXTERNAL_STOP_CONDITIONS,
  USER_DECISION_TRIGGERS,
  USAGE_FALLBACK_REQUEST_SCHEMA,
  type UsageFallbackRequest,
  type UsageFallbackResponse,
  type UsageFallbackTarget
} from "../core/contracts/usage-fallback.js";
import { createLogger } from "../core/logging/index.js";
import type { VegaMetricsRegistry } from "../monitoring/vega-metrics.js";

import type { UsageConsumptionCheckpointStore } from "./usage-consumption-checkpoint-store.js";

export type UsageFallbackDegradedReason =
  | "checkpoint_not_found"
  | "decision_state_not_external"
  | "store_unavailable";

export interface UsageFallbackMcpTool {
  name: "usage.fallback";
  description: string;
  inputSchema: object;
  invoke(request: unknown): Promise<UsageFallbackResponse>;
}

const logger = createLogger({ name: "usage-fallback-handler" });

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

function createUsageFallbackInputSchema(): object {
  const generated = normalizeZodJsonSchema(z.toJSONSchema(USAGE_FALLBACK_REQUEST_SCHEMA));
  return isRecord(generated) ? generated : {};
}

const USAGE_FALLBACK_INPUT_SCHEMA = createUsageFallbackInputSchema();

const formatValidationDetail = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "root" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");

function buildFallbackResponse(
  checkpointId: string,
  target: UsageFallbackTarget,
  ladderActive: boolean,
  userDecisionRequired: boolean,
  degraded?: UsageFallbackDegradedReason,
  retryHint?: string
): UsageFallbackResponse {
  const base: UsageFallbackResponse = {
    checkpoint_id: checkpointId,
    ladder_active: ladderActive,
    current_target: target,
    allowed_sources: target === "local_workspace"
      ? [...LOCAL_WORKSPACE_SOURCES]
      : target === "external"
        ? [...EXTERNAL_SOURCES]
        : [],
    stop_conditions: target === "local_workspace"
      ? [...LOCAL_STOP_CONDITIONS]
      : target === "external"
        ? [...EXTERNAL_STOP_CONDITIONS]
        : [],
    user_decision_required: userDecisionRequired
  };

  if (degraded) {
    base.degraded = degraded;
  }

  if (retryHint) {
    base.retry_hint = retryHint;
  }

  return base;
}

function processUsageFallback(
  request: UsageFallbackRequest,
  store: UsageConsumptionCheckpointStore | undefined,
  _metrics?: VegaMetricsRegistry
): UsageFallbackResponse {
  if (store === undefined) {
    logger.warn("usage_fallback_store_unavailable", {
      checkpoint_id: request.checkpoint_id
    });
    return buildFallbackResponse(
      request.checkpoint_id,
      "none",
      false,
      false,
      "store_unavailable",
      "Usage fallback store is not available."
    );
  }

  const checkpoint = store.get(request.checkpoint_id);

  if (checkpoint === undefined) {
    logger.warn("usage_fallback_checkpoint_not_found", {
      checkpoint_id: request.checkpoint_id
    });
    return buildFallbackResponse(
      request.checkpoint_id,
      "none",
      false,
      false,
      "checkpoint_not_found",
      "Checkpoint not found or expired. Submit a usage checkpoint first."
    );
  }

  if (checkpoint.decision_state !== "needs_external") {
    logger.info("usage_fallback_decision_state_not_external", {
      checkpoint_id: request.checkpoint_id,
      decision_state: checkpoint.decision_state
    });
    return buildFallbackResponse(
      request.checkpoint_id,
      "none",
      false,
      false,
      "decision_state_not_external",
      `Decision state is '${checkpoint.decision_state}', fallback ladder only activates for 'needs_external'.`
    );
  }



  if (!request.local_exhausted) {
    logger.info("usage_fallback_local_workspace", {
      checkpoint_id: request.checkpoint_id
    });
    return buildFallbackResponse(
      request.checkpoint_id,
      "local_workspace",
      true,
      false
    );
  }

  logger.info("usage_fallback_external", {
    checkpoint_id: request.checkpoint_id
  });
  return buildFallbackResponse(
    request.checkpoint_id,
    "external",
    true,
    true
  );
}

export function createUsageFallbackMcpTool(
  store: UsageConsumptionCheckpointStore | undefined,
  metrics?: VegaMetricsRegistry
): UsageFallbackMcpTool {
  return {
    name: "usage.fallback",
    description: "Retrieves a bounded fallback ladder plan for a usage checkpoint with decision_state=needs_external.",
    inputSchema: USAGE_FALLBACK_INPUT_SCHEMA,
    async invoke(request: unknown): Promise<UsageFallbackResponse> {
      const parsed = USAGE_FALLBACK_REQUEST_SCHEMA.parse(request);
      return processUsageFallback(parsed, store, metrics);
    }
  };
}

export function createUsageFallbackHttpHandler(
  store: UsageConsumptionCheckpointStore | undefined,
  metrics?: VegaMetricsRegistry
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = USAGE_FALLBACK_REQUEST_SCHEMA.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "ValidationError",
        detail: formatValidationDetail(parsed.error.issues)
      });
      return;
    }

    res.status(200).json(processUsageFallback(parsed.data, store, metrics));
  };
}
