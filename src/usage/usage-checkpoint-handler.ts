import type { Request, Response } from "express";
import { z } from "zod";

import {
  USAGE_CHECKPOINT_SCHEMA,
  type UsageCheckpoint
} from "../core/contracts/usage-checkpoint.js";
import { createLogger } from "../core/logging/index.js";
import type { VegaMetricsRegistry } from "../monitoring/vega-metrics.js";

import type { CheckpointStore } from "./checkpoint-store.js";
import type { UsageConsumptionCheckpointStore } from "./usage-consumption-checkpoint-store.js";

export type UsageCheckpointDegradedReason =
  | "usage_checkpoint_unavailable"
  | "persist_failed"
  | "low_confidence_checkpoint"
  | "validation_error";

export type UsageCheckpointDecisionState = "sufficient" | "needs_followup" | "needs_external";

export interface UsageCheckpointResponse {
  accepted: boolean;
  checkpoint_id: string;
  decision_state: UsageCheckpointDecisionState;
  degraded?: UsageCheckpointDegradedReason;
  retry_hint?: string;
  follow_up_hint?: {
    suggested_intent?: "followup" | "evidence";
    reason?: string;
  };
  handoff_hint?: {
    target: "local_workspace" | "external";
    reason: string;
  };
}

export interface UsageCheckpointMcpTool {
  name: "usage.checkpoint";
  description: string;
  inputSchema: object;
  invoke(request: unknown): Promise<UsageCheckpointResponse>;
}

const logger = createLogger({ name: "usage-checkpoint-handler" });

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

function createUsageCheckpointInputSchema(): object {
  const generated = normalizeZodJsonSchema(z.toJSONSchema(USAGE_CHECKPOINT_SCHEMA));
  return isRecord(generated) ? generated : {};
}

const USAGE_CHECKPOINT_INPUT_SCHEMA = createUsageCheckpointInputSchema();

const formatValidationDetail = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "root" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");

function validateCheckpointSemantics(
  checkpoint: UsageCheckpoint,
  retrievalCheckpointStore?: CheckpointStore
): { valid: true } | { valid: false; reason: string } {
  if (checkpoint.bundle_id.trim().length === 0) {
    return { valid: false, reason: "bundle_id must not be empty" };
  }

  if (checkpoint.checkpoint_id.trim().length === 0) {
    return { valid: false, reason: "checkpoint_id must not be empty" };
  }

  if (!["sufficient", "needs_followup", "needs_external"].includes(checkpoint.decision_state)) {
    return { valid: false, reason: "decision_state must be one of sufficient, needs_followup, needs_external" };
  }

  if (checkpoint.used_items.length === 0) {
    return { valid: false, reason: "used_items must not be empty when bundle is non-empty" };
  }

  if (checkpoint.working_summary.trim().length === 0) {
    return { valid: false, reason: "working_summary must not be empty" };
  }

  const allItemsAreBundleRefs = checkpoint.used_items.every((item) =>
    typeof item === "string" && /^[A-Za-z0-9_-]+:.+$/u.test(item)
  );

  if (!allItemsAreBundleRefs) {
    return { valid: false, reason: "used_items must contain valid bundle record references" };
  }

  if (
    checkpoint.bundle_summary !== undefined &&
    normalizeSummary(checkpoint.working_summary) === normalizeSummary(checkpoint.bundle_summary)
  ) {
    return { valid: false, reason: "working_summary must describe consumption, not copy the bundle summary" };
  }

  if (retrievalCheckpointStore !== undefined) {
    let retrievalCheckpoint;
    try {
      retrievalCheckpoint = retrievalCheckpointStore.get(checkpoint.checkpoint_id);
    } catch {
      return { valid: false, reason: "checkpoint bundle lookup failed" };
    }

    if (retrievalCheckpoint === undefined) {
      return { valid: false, reason: "checkpoint_id must refer to an active retrieval bundle" };
    }

    const receivedDigest = checkpoint.bundle_digest ?? checkpoint.bundle_id;
    if (receivedDigest !== retrievalCheckpoint.bundle_digest) {
      return { valid: false, reason: "bundle_digest must match the checkpoint retrieval bundle" };
    }

    const allowedRecordIds = new Set(retrievalCheckpoint.record_ids);
    const allUsedItemsBelongToBundle = checkpoint.used_items.every((item) => allowedRecordIds.has(item));
    if (!allUsedItemsBelongToBundle) {
      return { valid: false, reason: "used_items must reference records from the checkpoint retrieval bundle" };
    }
  }

  return { valid: true };
}

function normalizeSummary(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function isLowConfidenceCheckpoint(checkpoint: UsageCheckpoint): boolean {
  const summary = checkpoint.working_summary.trim().toLowerCase();
  const genericPatterns = [
    "summary",
    "overview",
    "brief",
    "general"
  ];

  const looksGeneric = genericPatterns.some((pattern) => summary.includes(pattern));
  const veryShort = checkpoint.working_summary.trim().length < 20;
  const fewItems = checkpoint.used_items.length <= 1;

  return looksGeneric || veryShort || fewItems;
}

function buildDecisionResponse(
  checkpoint: UsageCheckpoint,
  degraded?: UsageCheckpointDegradedReason,
  retryHint?: string
): UsageCheckpointResponse {
  const base: UsageCheckpointResponse = {
    accepted: true,
    checkpoint_id: checkpoint.checkpoint_id,
    decision_state: checkpoint.decision_state
  };

  if (degraded) {
    base.degraded = degraded;
  }

  if (retryHint) {
    base.retry_hint = retryHint;
  }

  if (checkpoint.decision_state === "needs_followup") {
    base.follow_up_hint = {
      suggested_intent: "followup",
      reason: "Host indicated the bundle is insufficient; a followup retrieval may resolve the gap."
    };
  }

  if (checkpoint.decision_state === "needs_external") {
    base.handoff_hint = {
      target: "local_workspace",
      reason: "Host indicated the gap is outside Vega's knowledge; consult local workspace or external sources."
    };
  }

  return base;
}

function buildRejectedResponse(checkpoint: UsageCheckpoint, retryHint: string): UsageCheckpointResponse {
  return {
    accepted: false,
    checkpoint_id: checkpoint.checkpoint_id,
    decision_state: checkpoint.decision_state,
    degraded: "validation_error",
    retry_hint: retryHint
  };
}

function processUsageCheckpoint(
  checkpoint: UsageCheckpoint,
  store: UsageConsumptionCheckpointStore | undefined,
  metrics?: VegaMetricsRegistry,
  retrievalCheckpointStore?: CheckpointStore
): UsageCheckpointResponse {
  const semanticValidation = validateCheckpointSemantics(checkpoint, retrievalCheckpointStore);

  if (!semanticValidation.valid) {
    metrics?.recordUsageCheckpointRejected("validation_error");
    return buildRejectedResponse(checkpoint, semanticValidation.reason);
  }

  metrics?.recordUsageCheckpointSubmitted(checkpoint.decision_state);

  if (store === undefined) {
    logger.warn("usage_checkpoint_unavailable", {
      checkpoint_id: checkpoint.checkpoint_id
    });
    return buildDecisionResponse(checkpoint, "usage_checkpoint_unavailable");
  }

  try {
    store.put(checkpoint);
  } catch (error) {
    logger.warn("usage_checkpoint_persist_failed", {
      checkpoint_id: checkpoint.checkpoint_id,
      error: error instanceof Error ? error.message : String(error)
    });
    return buildDecisionResponse(checkpoint, "persist_failed");
  }

  const lowConfidence = isLowConfidenceCheckpoint(checkpoint);

  if (lowConfidence) {
    metrics?.recordUsageCheckpointLowConfidence(checkpoint.decision_state);
    logger.info("low_confidence_checkpoint", {
      checkpoint_id: checkpoint.checkpoint_id,
      decision_state: checkpoint.decision_state
    });
    return buildDecisionResponse(checkpoint, "low_confidence_checkpoint");
  }

  return buildDecisionResponse(checkpoint);
}

export function createUsageCheckpointMcpTool(
  store: UsageConsumptionCheckpointStore | undefined,
  metrics?: VegaMetricsRegistry,
  retrievalCheckpointStore?: CheckpointStore
): UsageCheckpointMcpTool {
  return {
    name: "usage.checkpoint",
    description: "Submits a bundle consumption checkpoint after the host has consumed a context bundle.",
    inputSchema: USAGE_CHECKPOINT_INPUT_SCHEMA,
    async invoke(request: unknown): Promise<UsageCheckpointResponse> {
      const parsed = USAGE_CHECKPOINT_SCHEMA.parse(request);
      return processUsageCheckpoint(parsed, store, metrics, retrievalCheckpointStore);
    }
  };
}

export function createUsageCheckpointHttpHandler(
  store: UsageConsumptionCheckpointStore | undefined,
  metrics?: VegaMetricsRegistry,
  retrievalCheckpointStore?: CheckpointStore
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = USAGE_CHECKPOINT_SCHEMA.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: "ValidationError",
        detail: formatValidationDetail(parsed.error.issues)
      });
      return;
    }

    const result = processUsageCheckpoint(parsed.data, store, metrics, retrievalCheckpointStore);
    res.status(result.accepted ? 200 : 422).json(result);
  };
}
