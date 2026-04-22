export interface JudgmentRuleConfig {
  age_threshold_ms: number;
  min_sufficient_acks: number;
  min_distinct_sessions: number;
}

export interface JudgmentRules {
  name: string;
  version: string;
  rules: JudgmentRuleConfig;
}

export const DEFAULT_JUDGMENT_RULES: JudgmentRules = {
  name: "default",
  version: "v1",
  rules: {
    age_threshold_ms: 7 * 24 * 60 * 60 * 1_000,
    min_sufficient_acks: 3,
    min_distinct_sessions: 2
  }
};

export interface JudgmentRulesOverride {
  name?: string;
  version?: string;
  rules?: Partial<JudgmentRuleConfig>;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveJudgmentRulesOverrideFromEnv(
  env: NodeJS.ProcessEnv
): JudgmentRulesOverride {
  const override: JudgmentRulesOverride = {};
  const rules: Partial<JudgmentRuleConfig> = {};

  const name = env.VEGA_PROMOTION_RULESET_NAME?.trim();
  if (name) {
    override.name = name;
  }

  const version = env.VEGA_PROMOTION_RULESET_VERSION?.trim();
  if (version) {
    override.version = version;
  }

  const ageThresholdMs = parsePositiveInteger(env.VEGA_PROMOTION_AGE_THRESHOLD_MS);
  if (ageThresholdMs !== undefined) {
    rules.age_threshold_ms = ageThresholdMs;
  }

  const minSufficientAcks = parsePositiveInteger(env.VEGA_PROMOTION_MIN_SUFFICIENT_ACKS);
  if (minSufficientAcks !== undefined) {
    rules.min_sufficient_acks = minSufficientAcks;
  }

  const minDistinctSessions = parsePositiveInteger(env.VEGA_PROMOTION_MIN_DISTINCT_SESSIONS);
  if (minDistinctSessions !== undefined) {
    rules.min_distinct_sessions = minDistinctSessions;
  }

  if (Object.keys(rules).length > 0) {
    override.rules = rules;
  }

  return override;
}

export function createJudgmentRules(
  overrides: JudgmentRulesOverride = {}
): JudgmentRules {
  return {
    name: overrides.name ?? DEFAULT_JUDGMENT_RULES.name,
    version: overrides.version ?? DEFAULT_JUDGMENT_RULES.version,
    rules: {
      age_threshold_ms:
        overrides.rules?.age_threshold_ms ?? DEFAULT_JUDGMENT_RULES.rules.age_threshold_ms,
      min_sufficient_acks:
        overrides.rules?.min_sufficient_acks ?? DEFAULT_JUDGMENT_RULES.rules.min_sufficient_acks,
      min_distinct_sessions:
        overrides.rules?.min_distinct_sessions ?? DEFAULT_JUDGMENT_RULES.rules.min_distinct_sessions
    }
  };
}

export function mergeJudgmentRules(
  base: JudgmentRules,
  overrides: JudgmentRulesOverride
): JudgmentRules {
  return {
    name: overrides.name ?? base.name,
    version: overrides.version ?? base.version,
    rules: {
      age_threshold_ms:
        overrides.rules?.age_threshold_ms ?? base.rules.age_threshold_ms,
      min_sufficient_acks:
        overrides.rules?.min_sufficient_acks ?? base.rules.min_sufficient_acks,
      min_distinct_sessions:
        overrides.rules?.min_distinct_sessions ?? base.rules.min_distinct_sessions
    }
  };
}
