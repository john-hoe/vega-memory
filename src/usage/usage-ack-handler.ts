import type { Request, Response } from "express";
import { z } from "zod";

import {
  USAGE_ACK_SCHEMA,
  type UsageAck
} from "../core/contracts/usage-ack.js";
import { createLogger } from "../core/logging/index.js";

import type { AckStore } from "./ack-store.js";
import type { CheckpointStore } from "./checkpoint-store.js";

export type UsageAckDegradedReason =
  | "usage_ack_unavailable"
  | "persist_failed";

export interface UsageAckResponse {
  ack: true;
  follow_up_hint?: {
    suggested_intent: "followup";
  };
  degraded?: UsageAckDegradedReason;
}

export interface UsageAckMcpTool {
  name: "usage.ack";
  description: string;
  inputSchema: object;
  invoke(request: unknown): Promise<UsageAckResponse>;
}

const logger = createLogger({ name: "usage-ack-handler" });

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

function createUsageAckInputSchema(): object {
  const generated = normalizeZodJsonSchema(z.toJSONSchema(USAGE_ACK_SCHEMA));
  return isRecord(generated) ? generated : {};
}

const USAGE_ACK_INPUT_SCHEMA = createUsageAckInputSchema();

const formatValidationDetail = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "root" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");

function buildUsageAckResponse(ack: UsageAck): UsageAckResponse {
  if (ack.sufficiency === "needs_followup") {
    return {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    };
  }

  return { ack: true };
}

function processUsageAck(
  ack: UsageAck,
  ackStore: AckStore | undefined,
  checkpointStore?: CheckpointStore
): UsageAckResponse {
  const response = buildUsageAckResponse(ack);

  if (checkpointStore !== undefined) {
    try {
      if (checkpointStore.get(ack.checkpoint_id) === undefined) {
        logger.warn("ack_for_unknown_checkpoint", {
          checkpoint_id: ack.checkpoint_id
        });
      }
    } catch (error) {
      logger.warn("ack_checkpoint_lookup_failed", {
        checkpoint_id: ack.checkpoint_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (ackStore === undefined) {
    logger.warn("usage_ack_unavailable", {
      checkpoint_id: ack.checkpoint_id
    });
    return {
      ...response,
      degraded: "usage_ack_unavailable"
    };
  }

  try {
    ackStore.put({
      checkpoint_id: ack.checkpoint_id,
      bundle_digest: ack.bundle_digest,
      sufficiency: ack.sufficiency,
      host_tier: ack.host_tier,
      evidence: ack.evidence ?? null,
      turn_elapsed_ms: ack.turn_elapsed_ms ?? null
    });
    return response;
  } catch (error) {
    logger.warn("ack_persist_failed", {
      checkpoint_id: ack.checkpoint_id,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      ...response,
      degraded: "persist_failed"
    };
  }
}

export function createUsageAckMcpTool(
  ackStore: AckStore | undefined,
  checkpointStore?: CheckpointStore
): UsageAckMcpTool {
  return {
    name: "usage.ack",
    description: "Stores best-effort checkpoint usage feedback without blocking the host turn.",
    inputSchema: USAGE_ACK_INPUT_SCHEMA,
    async invoke(request: unknown): Promise<UsageAckResponse> {
      const parsed = USAGE_ACK_SCHEMA.parse(request);
      return processUsageAck(parsed, ackStore, checkpointStore);
    }
  };
}

export function createUsageAckHttpHandler(
  ackStore: AckStore | undefined,
  checkpointStore?: CheckpointStore
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = USAGE_ACK_SCHEMA.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "ValidationError",
        detail: formatValidationDetail(parsed.error.issues)
      });
      return;
    }

    res.status(200).json(processUsageAck(parsed.data, ackStore, checkpointStore));
  };
}
