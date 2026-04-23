import { z } from "zod";

export const LOCAL_WORKSPACE_SOURCES = [
  "repo_code",
  "current_file",
  "config_files",
  "test_output",
  "runtime_logs",
  "command_output",
  "environment_state"
] as const;

export const EXTERNAL_SOURCES = [
  "official_docs",
  "official_blog",
  "official_github",
  "trusted_third_party"
] as const;

export const LOCAL_STOP_CONDITIONS = [
  "sufficient_facts_for_next_step",
  "root_cause_identified",
  "gap_confirmed_external"
] as const;

export const EXTERNAL_STOP_CONDITIONS = [
  "sufficient_official_facts",
  "implementation_boundary_clear",
  "user_decision_required"
] as const;

export const USER_DECISION_TRIGGERS = [
  "conflicting_sources",
  "irreversible_side_effects",
  "authorization_required"
] as const;

export const USAGE_FALLBACK_REQUEST_SCHEMA = z.object({
  checkpoint_id: z.string().min(1),
  local_exhausted: z.boolean().default(false),
  local_outcome: z.object({
    checked_sources: z.array(z.enum(LOCAL_WORKSPACE_SOURCES)).min(1),
    stop_condition: z.enum(LOCAL_STOP_CONDITIONS),
    summary: z.string().trim().min(1)
  }).optional()
});

export type UsageFallbackRequest = z.infer<typeof USAGE_FALLBACK_REQUEST_SCHEMA>;
export type UsageFallbackRequestInput = z.input<typeof USAGE_FALLBACK_REQUEST_SCHEMA>;

export type UsageFallbackTarget = "local_workspace" | "external" | "none";

export interface UsageFallbackResponse {
  checkpoint_id: string;
  ladder_active: boolean;
  current_target: UsageFallbackTarget;
  allowed_sources: string[];
  stop_conditions: string[];
  user_decision_required: boolean;
  degraded?:
    | "checkpoint_not_found"
    | "decision_state_not_external"
    | "store_unavailable"
    | "local_evidence_required";
  retry_hint?: string;
}
