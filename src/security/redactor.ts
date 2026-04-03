const OPENAI_KEY_PATTERN = /sk-[a-zA-Z0-9]{20,}/g;
const AWS_KEY_PATTERN = /AKIA[A-Z0-9]{16}/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN\s+[\w\s]+PRIVATE\sKEY-----[\s\S]*?-----END\s+[\w\s]+PRIVATE\sKEY-----/g;
const URL_PASSWORD_PATTERN = /:\/\/([^:]+):([^@]+)@/g;
const GENERIC_SECRET_PATTERN =
  /(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi;

export function redactSensitiveData(
  content: string
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

  return { redacted, wasRedacted };
}
