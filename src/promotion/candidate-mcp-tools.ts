import { z } from "zod";

import type {
  CandidateQuery,
  CandidateRepository
} from "../db/candidate-repository.js";
import { MEMORY_TYPES } from "../db/repository.js";
import type { PromotionOrchestrator } from "./orchestrator.js";

interface CandidateMcpTool<TName extends string, TResponse> {
  name: TName;
  description: string;
  inputSchema: object;
  invoke(request: unknown): Promise<TResponse>;
}

interface CandidateSummary {
  id: string;
  content: string;
  type: string;
  project: string | null;
  tags: string[];
  candidate_state: string;
  extraction_source: string;
  extraction_confidence: number | null;
  visibility_gated: boolean;
  created_at: number;
  updated_at: number;
}

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

  return normalized;
}

function createInputSchema(schema: z.ZodType<unknown>): object {
  const generated = normalizeZodJsonSchema(z.toJSONSchema(schema));
  return isRecord(generated) ? generated : {};
}

export const CANDIDATE_CREATE_SCHEMA = z.object({
  content: z.string().trim().min(1),
  type: z.enum(MEMORY_TYPES),
  project: z.string().trim().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1)).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  extraction_source: z.string().trim().min(1),
  extraction_confidence: z.number().min(0).max(1).nullable().optional(),
  visibility_gated: z.boolean().optional().default(true)
});

export const CANDIDATE_LIST_SCHEMA = z.object({
  project: z.string().trim().min(1).nullable().optional(),
  type: z.string().trim().min(1).optional(),
  state: z.enum(["pending", "held", "ready", "discarded"]).optional(),
  limit: z.number().int().min(1).optional(),
  since: z.number().int().min(0).optional()
});

export const CANDIDATE_PROMOTE_SCHEMA = z.object({
  id: z.string().trim().min(1),
  actor: z.string().trim().min(1)
});

export const CANDIDATE_DEMOTE_SCHEMA = z.object({
  id: z.string().trim().min(1),
  actor: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional()
});

export const CANDIDATE_EVALUATE_SCHEMA = z.object({
  id: z.string().trim().min(1),
  actor: z.string().trim().min(1).optional().default("system")
});

export const CANDIDATE_SWEEP_SCHEMA = z.object({
  actor: z.string().trim().min(1).optional().default("system")
});

function toSummary(record: ReturnType<CandidateRepository["findById"]>): CandidateSummary {
  if (record === undefined) {
    throw new Error("Candidate summary requires a record");
  }

  return {
    id: record.id,
    content: record.content,
    type: record.type,
    project: record.project,
    tags: record.tags,
    candidate_state: record.candidate_state,
    extraction_source: record.extraction_source,
    extraction_confidence: record.extraction_confidence,
    visibility_gated: record.visibility_gated,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

export function createCandidateCreateMcpTool(
  candidateRepository: CandidateRepository | undefined
): CandidateMcpTool<
  "candidate_create",
  { id: string; candidate_state: string; created_at: number } | { degraded: "candidate_store_unavailable" }
> {
  return {
    name: "candidate_create",
    description: "Create a candidate memory without promoting it into the main memories table.",
    inputSchema: createInputSchema(CANDIDATE_CREATE_SCHEMA),
    async invoke(request) {
      if (candidateRepository === undefined) {
        return {
          degraded: "candidate_store_unavailable"
        };
      }

      const parsed = CANDIDATE_CREATE_SCHEMA.parse(request);
      const record = candidateRepository.create(parsed);

      return {
        id: record.id,
        candidate_state: record.candidate_state,
        created_at: record.created_at
      };
    }
  };
}

export function createCandidateListMcpTool(
  candidateRepository: CandidateRepository | undefined
): CandidateMcpTool<
  "candidate_list",
  { records: CandidateSummary[] } | { degraded: "candidate_store_unavailable" }
> {
  return {
    name: "candidate_list",
    description: "List candidate memories, optionally filtering by project, type, and candidate state.",
    inputSchema: createInputSchema(CANDIDATE_LIST_SCHEMA),
    async invoke(request) {
      if (candidateRepository === undefined) {
        return {
          degraded: "candidate_store_unavailable"
        };
      }

      const parsed = CANDIDATE_LIST_SCHEMA.parse(request);
      const query: CandidateQuery = {
        ...(parsed.project !== undefined ? { project: parsed.project } : {}),
        ...(parsed.type !== undefined ? { type: parsed.type } : {}),
        ...(parsed.state !== undefined ? { state: parsed.state } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        ...(parsed.since !== undefined ? { since: parsed.since } : {})
      };

      return {
        records: candidateRepository.list(query).map((record) => toSummary(record))
      };
    }
  };
}

export function createCandidatePromoteMcpTool(
  orchestrator: PromotionOrchestrator | undefined
): CandidateMcpTool<
  "candidate_promote",
  | {
      status: string;
      memory_id: string;
      audit_entry_id: string;
      reason: string;
    }
  | { degraded: "promotion_unavailable" }
> {
  return {
    name: "candidate_promote",
    description: "Manually promote a candidate into the main memories table through the promotion policy engine.",
    inputSchema: createInputSchema(CANDIDATE_PROMOTE_SCHEMA),
    async invoke(request) {
      if (orchestrator === undefined) {
        return {
          degraded: "promotion_unavailable"
        };
      }

      const parsed = CANDIDATE_PROMOTE_SCHEMA.parse(request);
      const result = orchestrator.promoteManual(parsed.id, parsed.actor);

      return {
        status: result.status,
        memory_id: result.memory_id,
        audit_entry_id: result.audit_entry_id,
        reason: result.decision.reason
      };
    }
  };
}

export function createCandidateDemoteMcpTool(
  orchestrator: PromotionOrchestrator | undefined
): CandidateMcpTool<
  "candidate_demote",
  | {
      status: string;
      memory_id: string;
      audit_entry_id: string;
      reason: string;
    }
  | { degraded: "promotion_unavailable" }
> {
  return {
    name: "candidate_demote",
    description: "Manually demote a promoted memory back into the candidate lifecycle.",
    inputSchema: createInputSchema(CANDIDATE_DEMOTE_SCHEMA),
    async invoke(request) {
      if (orchestrator === undefined) {
        return {
          degraded: "promotion_unavailable"
        };
      }

      const parsed = CANDIDATE_DEMOTE_SCHEMA.parse(request);
      const result = orchestrator.demoteManual(parsed.id, parsed.actor, parsed.reason);

      return {
        status: result.status,
        memory_id: result.memory_id,
        audit_entry_id: result.audit_entry_id,
        reason: result.decision.reason
      };
    }
  };
}

export function createCandidateEvaluateMcpTool(
  orchestrator: PromotionOrchestrator | undefined
): CandidateMcpTool<
  "candidate_evaluate",
  | {
      status: string;
      memory_id: string;
      audit_entry_id: string;
      reason: string;
    }
  | { degraded: "promotion_unavailable" }
> {
  return {
    name: "candidate_evaluate",
    description: "Run the policy trigger against one candidate without forcing a manual promotion.",
    inputSchema: createInputSchema(CANDIDATE_EVALUATE_SCHEMA),
    async invoke(request) {
      if (orchestrator === undefined) {
        return {
          degraded: "promotion_unavailable"
        };
      }

      const parsed = CANDIDATE_EVALUATE_SCHEMA.parse(request);
      const result = orchestrator.evaluateAndAct(parsed.id, "policy", parsed.actor);

      return {
        status: result.status,
        memory_id: result.memory_id,
        audit_entry_id: result.audit_entry_id,
        reason: result.decision.reason
      };
    }
  };
}

export function createCandidateSweepMcpTool(
  orchestrator: PromotionOrchestrator | undefined
): CandidateMcpTool<
  "candidate_sweep",
  | {
      results: Array<{
        status: string;
        memory_id: string;
        audit_entry_id: string;
        reason: string;
      }>;
    }
  | { degraded: "promotion_unavailable" }
> {
  return {
    name: "candidate_sweep",
    description: "Run the sweep trigger across all sweep-eligible candidates.",
    inputSchema: createInputSchema(CANDIDATE_SWEEP_SCHEMA),
    async invoke(request) {
      if (orchestrator === undefined) {
        return {
          degraded: "promotion_unavailable"
        };
      }

      const parsed = CANDIDATE_SWEEP_SCHEMA.parse(request);
      const results = orchestrator.runSweep(parsed.actor);

      return {
        results: results.map((result) => ({
          status: result.status,
          memory_id: result.memory_id,
          audit_entry_id: result.audit_entry_id,
          reason: result.decision.reason
        }))
      };
    }
  };
}
