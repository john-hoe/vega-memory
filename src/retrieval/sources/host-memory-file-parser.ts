import { createLogger } from "../../core/logging/index.js";

const logger = createLogger({
  name: "retrieval-source-host-memory-file-parser"
});

export type DetectedFormatVersion = "v1" | "unknown";

export interface HostMemoryFileParseResult {
  title?: string;
  body: string;
  detected_format_version: DetectedFormatVersion;
}

export interface HostMemoryFileFrontmatterParseResult extends HostMemoryFileParseResult {
  frontmatter: Record<string, unknown>;
}

function withDetectedFormatVersion<T extends object>(
  result: T,
  detectedFormatVersion: DetectedFormatVersion
): T & { detected_format_version: DetectedFormatVersion } {
  return Object.defineProperty(result, "detected_format_version", {
    value: detectedFormatVersion,
    enumerable: false,
    configurable: true
  }) as T & { detected_format_version: DetectedFormatVersion };
}

function parseFrontmatterValue(value: string): unknown {
  const trimmed = value.trim();

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed.replace(/^["']|["']$/gu, "");
}

function parseFrontmatter(lines: string[]): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");

    if (separatorIndex < 1) {
      throw new Error(`Invalid frontmatter line: ${trimmed}`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1);
    frontmatter[key] = parseFrontmatterValue(value);
  }

  return frontmatter;
}

export function parseMarkdownFrontmatter(content: string): {
  title?: string;
  body: string;
  frontmatter: Record<string, unknown>;
  detected_format_version: DetectedFormatVersion;
} {
  try {
    const normalized = content.replace(/\r\n/gu, "\n");

    if (!normalized.startsWith("---\n")) {
      return withDetectedFormatVersion({
        title: undefined,
        body: normalized.trim(),
        frontmatter: {}
      }, "v1");
    }

    const lines = normalized.split("\n");
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

    if (closingIndex < 0) {
      throw new Error("Missing closing frontmatter delimiter");
    }

    const frontmatter = parseFrontmatter(lines.slice(1, closingIndex));
    const title = typeof frontmatter.title === "string" ? frontmatter.title : undefined;

    return withDetectedFormatVersion({
      title,
      body: lines.slice(closingIndex + 1).join("\n").trim(),
      frontmatter
    }, "v1");
  } catch (error) {
    logger.warn("Failed to parse markdown frontmatter; falling back to raw content", {
      error: error instanceof Error ? error.message : String(error)
    });
    const fallback = parsePlainText(content);

    return withDetectedFormatVersion({
      title: fallback.title,
      body: fallback.body,
      frontmatter: {}
    }, "unknown");
  }
}

export function parsePlainText(content: string): HostMemoryFileParseResult {
  try {
    const normalized = content.replace(/\r\n/gu, "\n");
    const lines = normalized.split("\n");
    const titleIndex = lines.findIndex((line) => line.trim().length > 0);

    if (titleIndex < 0) {
      return withDetectedFormatVersion({
        title: undefined,
        body: ""
      }, "v1");
    }

    return withDetectedFormatVersion({
      title: lines[titleIndex]?.trim(),
      body: lines.slice(titleIndex + 1).join("\n").trim()
    }, "v1");
  } catch (error) {
    logger.warn("Failed to parse plain text host-memory file; falling back to raw content", {
      error: error instanceof Error ? error.message : String(error)
    });

    return withDetectedFormatVersion({
      title: undefined,
      body: content
    }, "unknown");
  }
}

export function parseJson(content: string): HostMemoryFileParseResult {
  try {
    const parsed = JSON.parse(content) as unknown;

    if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
      return withDetectedFormatVersion({
        title: undefined,
        body: JSON.stringify(parsed, null, 2)
      }, "v1");
    }

    const { title, ...rest } = parsed as Record<string, unknown> & { title?: unknown };

    return withDetectedFormatVersion({
      title: typeof title === "string" ? title : undefined,
      body: JSON.stringify(rest, null, 2)
    }, "v1");
  } catch (error) {
    logger.warn("Failed to parse JSON host-memory file; falling back to raw content", {
      error: error instanceof Error ? error.message : String(error)
    });

    return withDetectedFormatVersion({
      title: undefined,
      body: content
    }, "unknown");
  }
}
