const EMOTIONAL_PATTERN = /(真垃圾|烦死|fuck|shit|damn|hate this)/i;
const ACTIONABLE_PATTERN =
  /(fix|resolve|implement|need to|should|todo|next step|bug|error|stack|plan|修复|解决|需要|应该|下一步|待办)/i;
const ONE_TIME_QUERY_PATTERN = /^(这个|what does|explain|帮我查|什么意思).{0,50}[?？]$/i;
const COMMON_KNOWLEDGE_PATTERN = /(how to|怎么写|for loop|import module)/i;
const FAILED_DEBUG_ATTEMPT_PATTERN =
  /(tried|attempted|switched|changed|tested|试了|改成|换成).{0,80}(didn'?t work|no effect|still fails|still broken|没用|没效果|还是报错)/i;
const ONE_TIME_COMMAND_PATTERN =
  /^(run|rerun|restart|start|stop|kill|npm install|pnpm install|yarn install|brew install|git pull|git push|docker compose (up|down|restart)|执行|运行|重启|启动|停止|安装).{0,120}$/i;
const INCONCLUSIVE_EXPLORATION_PATTERN =
  /(looked through|browsed|checked|inspected|reviewed|看了|查了|翻了).{0,120}(nothing|no clue|unclear|not sure|didn'?t find|没发现|不确定)/i;
const META_DISCUSSION_PATTERN =
  /(remember this in vega|store this in memory|memory_store|记到记忆里|记到 memory|记忆系统本身)/i;
const NON_CODING_PATTERN =
  /(write an email|draft an email|check the weather|weather forecast|book a hotel|translate this|写封邮件|查天气|订酒店|翻译一下)/i;

const isLikelyRawDataDump = (content: string): boolean => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 40) {
    return content.length > 2000 && getNonAlphabeticRatio(content) > 0.5;
  }

  const structuredLineCount = lines.filter((line) =>
    /^(at\s+\S+|\d{4}-\d{2}-\d{2}|[A-Z_][A-Z0-9_]+[:=]|[{[(<]|[}\])>]|\/.*:\d+|[A-Za-z0-9_.-]+\s*[:=])/.test(
      line
    )
  ).length;
  const longLineCount = lines.filter((line) => line.length >= 120).length;

  return (
    structuredLineCount / lines.length >= 0.35 ||
    longLineCount >= 10 ||
    getNonAlphabeticRatio(content) > 0.45
  );
};

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

  if (FAILED_DEBUG_ATTEMPT_PATTERN.test(normalized)) {
    return {
      excluded: true,
      reason: "failed debug attempt without durable lesson"
    };
  }

  if (ONE_TIME_COMMAND_PATTERN.test(normalized)) {
    return {
      excluded: true,
      reason: "one-time command"
    };
  }

  if (INCONCLUSIVE_EXPLORATION_PATTERN.test(normalized)) {
    return {
      excluded: true,
      reason: "inconclusive exploration"
    };
  }

  if (META_DISCUSSION_PATTERN.test(normalized)) {
    return {
      excluded: true,
      reason: "meta-discussion"
    };
  }

  if (NON_CODING_PATTERN.test(normalized)) {
    return {
      excluded: true,
      reason: "non-coding task"
    };
  }

  if (isLikelyRawDataDump(normalized)) {
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
