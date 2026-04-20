import { type Intent, type SourceKind } from "../core/contracts/enums.js";

export type RetrievalDepth = "minimal" | "standard" | "extended" | "evidence";

export interface IntentProfile {
  intent: Intent;
  default_sources: SourceKind[];
  default_depth: RetrievalDepth;
  default_top_k: number;
  description: string;
}

export const BOOTSTRAP_PROFILE: IntentProfile = {
  intent: "bootstrap",
  default_sources: ["vega_memory", "wiki", "fact_claim", "graph", "archive", "host_memory_file"],
  default_depth: "standard",
  default_top_k: 5,
  description: "Session bootstrap recall across promoted, documentary, and archival sources."
};

export const LOOKUP_PROFILE: IntentProfile = {
  intent: "lookup",
  default_sources: ["vega_memory", "wiki", "fact_claim", "host_memory_file"],
  default_depth: "minimal",
  default_top_k: 3,
  description: "Precise lookup against the hot memory, wiki, and fact-claim surfaces."
};

export const FOLLOWUP_PROFILE: IntentProfile = {
  intent: "followup",
  default_sources: ["vega_memory", "candidate", "wiki", "host_memory_file"],
  default_depth: "standard",
  default_top_k: 3,
  description: "Follow-up recall that may expand into candidate memory before escalation."
};

export const EVIDENCE_PROFILE: IntentProfile = {
  intent: "evidence",
  default_sources: ["archive", "fact_claim", "graph", "host_memory_file"],
  default_depth: "evidence",
  default_top_k: 5,
  description: "Evidence-oriented recall that prioritizes archival and provenance-bearing sources."
};

export const INTENT_PROFILES: Record<Intent, IntentProfile> = {
  bootstrap: BOOTSTRAP_PROFILE,
  lookup: LOOKUP_PROFILE,
  followup: FOLLOWUP_PROFILE,
  evidence: EVIDENCE_PROFILE
};

export function getProfile(intent: Intent): IntentProfile {
  const profile = INTENT_PROFILES[intent];

  if (profile === undefined) {
    throw new Error(`Unknown intent profile: ${intent}`);
  }

  return profile;
}
