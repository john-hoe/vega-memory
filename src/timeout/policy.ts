import type { DetectedTimeout } from "./detector.js";

export type { DetectedTimeout } from "./detector.js";

export interface TimeoutPolicyDecision {
  decision: "presumed_sufficient" | "hard_failure";
  reason: string;
}

export function classifyTimeout({
  host_tier
}: DetectedTimeout): TimeoutPolicyDecision {
  if (host_tier === "T1") {
    return {
      decision: "presumed_sufficient",
      reason: "l1_ttl_expired_tier_t1"
    };
  }

  if (host_tier === "T2") {
    return {
      decision: "presumed_sufficient",
      reason: "l1_ttl_expired_tier_t2"
    };
  }

  if (host_tier === "T3") {
    return {
      decision: "hard_failure",
      reason: "l1_ttl_expired_tier_t3"
    };
  }

  return {
    decision: "hard_failure",
    reason: "l1_ttl_expired_tier_unknown"
  };
}
