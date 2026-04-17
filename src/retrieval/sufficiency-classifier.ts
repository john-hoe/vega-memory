import type { IntentProfile } from "./profiles.js";

export type SufficiencyHint = "likely_sufficient" | "may_need_followup";
export type SufficiencyRule = "empty" | "truncated" | "below_top_k";

export interface SufficiencyInput {
  profile: IntentProfile;
  budgeted_count: number;
  truncated_count: number;
}

export interface SufficiencyClassification {
  hint: SufficiencyHint;
  rules_fired: SufficiencyRule[];
  classifier_version: string;
}

export const SUFFICIENCY_CLASSIFIER_VERSION = "v0";

export function classifySufficiency(input: SufficiencyInput): SufficiencyClassification {
  const rules_fired: SufficiencyRule[] = [];

  if (input.budgeted_count === 0) {
    rules_fired.push("empty");
  }

  if (input.truncated_count > 0) {
    rules_fired.push("truncated");
  }

  if (
    input.budgeted_count < input.profile.default_top_k &&
    !rules_fired.includes("empty")
  ) {
    rules_fired.push("below_top_k");
  }

  return {
    hint: rules_fired.length === 0 ? "likely_sufficient" : "may_need_followup",
    rules_fired,
    classifier_version: SUFFICIENCY_CLASSIFIER_VERSION
  };
}
