const FTS_TOKEN_SPLIT_REGEX =
  /[\s,.;:!?()[\]{}<>'"*+\-/\\|=@#$%^&~`]+/u;
const WORD_BEARING_TOKEN_REGEX = /[\p{L}\p{N}]/u;
const SIMPLE_ASCII_FTS_QUERY_REGEX = /^[A-Za-z0-9_\s]+$/u;

export function escapeFtsMatchQuery(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return "\"\"";
  }

  if (SIMPLE_ASCII_FTS_QUERY_REGEX.test(trimmed)) {
    return trimmed;
  }

  const tokens = trimmed
    .split(FTS_TOKEN_SPLIT_REGEX)
    .filter((token) => token.length > 0 && WORD_BEARING_TOKEN_REGEX.test(token))
    .map((token) => `"${token}"`);

  return tokens.length === 0 ? "\"\"" : tokens.join(" OR ");
}
