import type { RedactionPattern } from "../core/types.js";

const OPENAI_KEY_PATTERN = /sk-[a-zA-Z0-9]{20,}/g;
const AWS_KEY_PATTERN = /AKIA[A-Z0-9]{16}/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN\s+[\w\s]+PRIVATE\sKEY-----[\s\S]*?-----END\s+[\w\s]+PRIVATE\sKEY-----/g;
const URL_PASSWORD_PATTERN = /:\/\/([^:]+):([^@]+)@/g;
const GENERIC_SECRET_PATTERN =
  /(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi;

const REGEXP_LITERAL_PATTERN = /^\/([\s\S]+)\/([dgimsuvy]*)$/;

const toReplacementToken = (name: string): string =>
  `[REDACTED:${name.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "CUSTOM"}]`;

const compilePattern = (pattern: string): RegExp | null => {
  const literalMatch = pattern.match(REGEXP_LITERAL_PATTERN);

  try {
    if (literalMatch) {
      const [, source, rawFlags] = literalMatch;
      const flags = rawFlags.includes("g") ? rawFlags : `${rawFlags}g`;
      return new RegExp(source, flags);
    }

    return new RegExp(pattern, "g");
  } catch {
    return null;
  }
};

export function redactSensitiveData(
  content: string,
  customPatterns: RedactionPattern[] = []
): { redacted: string; wasRedacted: boolean } {
  let wasRedacted = false;

  const applyReplacement = (
    input: string,
    pattern: RegExp,
    replacement: string | ((substring: string, ...args: string[]) => string)
  ): string =>
    input.replace(pattern, (...args) => {
      wasRedacted = true;

      if (typeof replacement === "string") {
        return replacement;
      }

      const captures = args.slice(1, -2) as string[];
      return replacement(args[0], ...captures);
    });

  let redacted = content;

  redacted = applyReplacement(
    redacted,
    PRIVATE_KEY_PATTERN,
    "[REDACTED:PRIVATE_KEY]"
  );
  redacted = applyReplacement(redacted, OPENAI_KEY_PATTERN, "[REDACTED:API_KEY]");
  redacted = applyReplacement(redacted, AWS_KEY_PATTERN, "[REDACTED:AWS_KEY]");
  redacted = applyReplacement(
    redacted,
    URL_PASSWORD_PATTERN,
    (_substring, username) => `://${username}:[REDACTED:PASSWORD]@`
  );
  redacted = applyReplacement(
    redacted,
    GENERIC_SECRET_PATTERN,
    (_substring, label) => `${label}=[REDACTED:SECRET]`
  );

  for (const customPattern of customPatterns) {
    if (customPattern.enabled === false) {
      continue;
    }

    const compiledPattern = compilePattern(customPattern.pattern);
    if (compiledPattern === null) {
      continue;
    }

    redacted = applyReplacement(
      redacted,
      compiledPattern,
      customPattern.replacement ?? toReplacementToken(customPattern.name)
    );
  }

  return { redacted, wasRedacted };
}
