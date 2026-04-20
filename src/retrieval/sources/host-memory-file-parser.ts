import { createLogger } from "../../core/logging/index.js";

const logger = createLogger({
  name: "retrieval-source-host-memory-file-parser"
});

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
} {
  try {
    const normalized = content.replace(/\r\n/gu, "\n");

    if (!normalized.startsWith("---\n")) {
      return {
        title: undefined,
        body: normalized.trim(),
        frontmatter: {}
      };
    }

    const lines = normalized.split("\n");
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

    if (closingIndex < 0) {
      throw new Error("Missing closing frontmatter delimiter");
    }

    const frontmatter = parseFrontmatter(lines.slice(1, closingIndex));
    const title = typeof frontmatter.title === "string" ? frontmatter.title : undefined;

    return {
      title,
      body: lines.slice(closingIndex + 1).join("\n").trim(),
      frontmatter
    };
  } catch (error) {
    logger.warn("Failed to parse markdown frontmatter; falling back to raw content", {
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      title: undefined,
      body: content,
      frontmatter: {}
    };
  }
}

export function parsePlainText(content: string): { title?: string; body: string } {
  try {
    const normalized = content.replace(/\r\n/gu, "\n");
    const lines = normalized.split("\n");
    const titleIndex = lines.findIndex((line) => line.trim().length > 0);

    if (titleIndex < 0) {
      return {
        title: undefined,
        body: ""
      };
    }

    return {
      title: lines[titleIndex]?.trim(),
      body: lines.slice(titleIndex + 1).join("\n").trim()
    };
  } catch (error) {
    logger.warn("Failed to parse plain text host-memory file; falling back to raw content", {
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      title: undefined,
      body: content
    };
  }
}

export function parseJson(content: string): { title?: string; body: string } {
  try {
    const parsed = JSON.parse(content) as unknown;

    if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
      return {
        title: undefined,
        body: JSON.stringify(parsed, null, 2)
      };
    }

    const { title, ...rest } = parsed as Record<string, unknown> & { title?: unknown };

    return {
      title: typeof title === "string" ? title : undefined,
      body: JSON.stringify(rest, null, 2)
    };
  } catch (error) {
    logger.warn("Failed to parse JSON host-memory file; falling back to raw content", {
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      title: undefined,
      body: content
    };
  }
}
