const EMOTIONAL_PATTERN = /(真垃圾|烦死|fuck|shit|damn|hate this)/i;
const ACTIONABLE_PATTERN =
  /(fix|resolve|implement|need to|should|todo|next step|bug|error|stack|plan|修复|解决|需要|应该|下一步|待办)/i;
const ONE_TIME_QUERY_PATTERN = /^(这个|what does|explain|帮我查|什么意思).{0,50}[?？]$/i;
const COMMON_KNOWLEDGE_PATTERN = /(how to|怎么写|for loop|import module)/i;

const getNonAlphabeticRatio = (content: string): number => {
  const significant = content.replace(/\s+/g, "");

  if (significant.length === 0) {
    return 0;
  }

  const alphabeticCount = (significant.match(/[a-z]/gi) ?? []).length;
  return (significant.length - alphabeticCount) / significant.length;
};

export function shouldExclude(content: string): { excluded: boolean; reason: string } {
  const normalized = content.trim();

  if (
    EMOTIONAL_PATTERN.test(normalized) &&
    !ACTIONABLE_PATTERN.test(normalized)
  ) {
    return {
      excluded: true,
      reason: "emotional complaint without actionable content"
    };
  }

  if (ONE_TIME_QUERY_PATTERN.test(normalized)) {
    return {
      excluded: true,
      reason: "one-time query"
    };
  }

  if (normalized.length > 2000 && getNonAlphabeticRatio(normalized) > 0.5) {
    return {
      excluded: true,
      reason: "raw data dump"
    };
  }

  if (COMMON_KNOWLEDGE_PATTERN.test(normalized) && normalized.length < 100) {
    return {
      excluded: true,
      reason: "common knowledge"
    };
  }

  return {
    excluded: false,
    reason: ""
  };
}
