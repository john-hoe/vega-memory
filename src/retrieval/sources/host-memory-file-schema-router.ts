import type { HostMemorySurface } from "./host-memory-file-paths.js";
import {
  parseMarkdownFrontmatter,
  parsePlainText,
  type HostMemoryFileParseResult
} from "./host-memory-file-parser.js";

export interface HostMemoryFileSchemaRouter {
  selectParser(input: {
    surface: HostMemorySurface;
    contentSample: string;
  }): (content: string) => HostMemoryFileParseResult;
}

const FRONTMATTER_SIGNATURE = /^---\n/u;

function normalizeContentSample(contentSample: string): string {
  return contentSample.replace(/\r\n/gu, "\n");
}

function selectV1Parser(contentSample: string): (content: string) => HostMemoryFileParseResult {
  return FRONTMATTER_SIGNATURE.test(normalizeContentSample(contentSample))
    ? parseMarkdownFrontmatter
    : parsePlainText;
}

export function createDefaultSchemaRouter(): HostMemoryFileSchemaRouter {
  return {
    selectParser({ surface, contentSample }) {
      switch (surface) {
        case "cursor":
        case "codex":
        case "claude":
        case "claude-projects":
        case "omc":
          return selectV1Parser(contentSample);
        default:
          return parsePlainText;
      }
    }
  };
}
