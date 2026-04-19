import type { Request, Response } from "express";
import { z } from "zod";

import {
  USAGE_ACK_SCHEMA,
  type UsageAck
} from "../core/contracts/usage-ack.js";
import { createLogger } from "../core/logging/index.js";
import type { VegaMetricsRegistry } from "../monitoring/vega-metrics.js";
import type { CircuitBreaker } from "../retrieval/circuit-breaker.js";

import type { AckRecord, AckStore } from "./ack-store.js";
import type { CheckpointStore } from "./checkpoint-store.js";

export type UsageAckDegradedReason =
  | "usage_ack_unavailable"
  | "bundle_digest_mismatch"
  | "ack_already_recorded"
  | "persist_failed"
  | "needs_followup_loop_limit";

export interface UsageAckResponse {
  ack: true;
  follow_up_hint?: {
    suggested_intent: "followup";
  };
  degraded?: UsageAckDegradedReason;
  forced_sufficiency?: "needs_external";
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
const DEFAULT_LOOP_GUARD_WINDOW_MS = 1_800_000;

const formatValidationDetail = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "root" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");

function buildResponseFromRecord(record: {
  sufficiency: UsageAck["sufficiency"];
  guard_overridden: boolean;
}): UsageAckResponse {
  if (record.sufficiency === "needs_followup") {
    return {
      ack: true,
      follow_up_hint: {
        suggested_intent: "followup"
      }
    };
  }

  if (record.sufficiency === "needs_external" && record.guard_overridden) {
    return {
      ack: true,
      degraded: "needs_followup_loop_limit",
      forced_sufficiency: "needs_external"
    };
  }

  return { ack: true };
}

function resolveLoopGuardWindowMs(): number {
  const envValue = Number.parseInt(process.env.VEGA_LOOP_GUARD_WINDOW_MS ?? "", 10);
  return Number.isInteger(envValue) && envValue > 0
    ? envValue
    : DEFAULT_LOOP_GUARD_WINDOW_MS;
}

function processUsageAck(
  ack: UsageAck,
  ackStore: AckStore | undefined,
  checkpointStore?: CheckpointStore,
  now: () => number = Date.now,
  circuitBreaker?: CircuitBreaker,
  metrics?: VegaMetricsRegistry
): UsageAckResponse {
  const loopGuardWindowMs = resolveLoopGuardWindowMs();
  let session_id: string | null = null;
  let digestMismatch = false;
  let previousCheckpoint;

  if (checkpointStore !== undefined) {
    try {
      previousCheckpoint = checkpointStore.get(ack.checkpoint_id);
      const checkpoint = previousCheckpoint;

      if (checkpoint === undefined) {
        logger.warn("ack_for_unknown_checkpoint", {
          checkpoint_id: ack.checkpoint_id
        });
      } else {
        session_id = checkpoint.session_id;

        if (checkpoint.bundle_digest !== ack.bundle_digest) {
          digestMismatch = true;
          logger.warn("ack_bundle_digest_mismatch", {
            checkpoint_id: ack.checkpoint_id,
            expected: checkpoint.bundle_digest,
            received: ack.bundle_digest
          });
        }
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
      ack: true,
      degraded: "usage_ack_unavailable"
    };
  }

  if (digestMismatch) {
    return {
      ack: true,
      degraded: "bundle_digest_mismatch"
    };
  }

  let putResult: ReturnType<AckStore["put"]>;
  try {
    putResult = ackStore.put({
      checkpoint_id: ack.checkpoint_id,
      bundle_digest: ack.bundle_digest,
      sufficiency: ack.sufficiency,
      host_tier: ack.host_tier,
      evidence: ack.evidence ?? null,
      turn_elapsed_ms: ack.turn_elapsed_ms ?? null,
      session_id
    });
  } catch (error) {
    logger.warn("ack_persist_failed", {
      checkpoint_id: ack.checkpoint_id,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      ack: true,
      degraded: "persist_failed"
    };
  }

  if (putResult.status === "conflict") {
    return {
      ack: true,
      degraded: "ack_already_recorded"
    };
  }

  if (putResult.status === "idempotent") {
    return buildResponseFromRecord(putResult.record);
  }

  if (previousCheckpoint !== undefined) {
    metrics?.recordUsageAck(previousCheckpoint.surface, ack.sufficiency, ack.host_tier);
  }

  if (circuitBreaker !== undefined && checkpointStore !== undefined && previousCheckpoint !== undefined) {
    circuitBreaker.recordAck(previousCheckpoint.surface, ack.sufficiency);
  }

  if (ack.sufficiency === "needs_followup" && session_id !== null) {
    try {
      const loopGuardFired =
        ackStore.countRecent({
          session_id,
          sufficiency: "needs_followup",
          since: now() - loopGuardWindowMs,
          exclude_checkpoint_id: ack.checkpoint_id
        }) >= 1;

      if (loopGuardFired) {
        let overrideSucceeded = false;
        try {
          ackStore.overrideSufficiency(ack.checkpoint_id, "needs_external");
          overrideSucceeded = true;
          if (previousCheckpoint !== undefined) {
            metrics?.recordLoopOverride(previousCheckpoint.surface);
          }
        } catch (error) {
          logger.warn("overrideSufficiency failed", {
            checkpoint_id: ack.checkpoint_id,
            error: error instanceof Error ? error.message : String(error)
          });
        }

        // Rebuild response from effective stored state so first-answer and retry
        // stay consistent: if override failed, stored still has sufficiency=needs_followup
        // and retry (idempotent) would return follow_up_hint — match that now.
        const effectiveRecord: AckRecord = overrideSucceeded
          ? { ...putResult.record, sufficiency: "needs_external", guard_overridden: true }
          : putResult.record;

        return buildResponseFromRecord(effectiveRecord);
      }
    } catch (error) {
      logger.warn("loop_guard_query_failed", {
        session_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return buildResponseFromRecord(putResult.record);
}

export function createUsageAckMcpTool(
  ackStore: AckStore | undefined,
  checkpointStore?: CheckpointStore,
  now?: () => number,
  circuitBreaker?: CircuitBreaker,
  metrics?: VegaMetricsRegistry
): UsageAckMcpTool {
  return {
    name: "usage.ack",
    description: "Stores best-effort checkpoint usage feedback without blocking the host turn.",
    inputSchema: USAGE_ACK_INPUT_SCHEMA,
    async invoke(request: unknown): Promise<UsageAckResponse> {
      const parsed = USAGE_ACK_SCHEMA.parse(request);
      return processUsageAck(parsed, ackStore, checkpointStore, now, circuitBreaker, metrics);
    }
  };
}

export function createUsageAckHttpHandler(
  ackStore: AckStore | undefined,
  checkpointStore?: CheckpointStore,
  now?: () => number,
  circuitBreaker?: CircuitBreaker,
  metrics?: VegaMetricsRegistry
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

    res
      .status(200)
      .json(processUsageAck(parsed.data, ackStore, checkpointStore, now, circuitBreaker, metrics));
  };
}
