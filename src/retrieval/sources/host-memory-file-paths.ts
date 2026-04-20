import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Surface } from "../../core/contracts/enums.js";

export type HostMemoryFileParser = "markdown_frontmatter" | "plain_text" | "json";
export type HostMemorySurface = Surface | "claude-projects" | "omc";

export interface PathSpec {
  surface: HostMemorySurface;
  pattern: string;
  parser: HostMemoryFileParser;
}

export const HOST_MEMORY_FILE_PATH_SPECS: readonly PathSpec[] = [
  {
    surface: "cursor",
    pattern: "~/.cursor/rules/memory.mdc",
    parser: "markdown_frontmatter"
  },
  {
    surface: "codex",
    pattern: "~/.codex/AGENTS.md",
    parser: "plain_text"
  },
  {
    surface: "claude",
    pattern: "~/.claude/CLAUDE.md",
    parser: "plain_text"
  },
  {
    surface: "claude-projects",
    pattern: "~/.claude/projects/*/memory/*.md",
    parser: "markdown_frontmatter"
  },
  {
    surface: "omc",
    pattern: "~/.omc/notepad.md",
    parser: "plain_text"
  }
] as const;

function expandPattern(homeDir: string, pattern: string): string[] {
  if (homeDir.trim().length === 0 || !pattern.startsWith("~/")) {
    return [];
  }

  return expandSegments(resolve(homeDir), pattern.slice(2).split("/"));
}

function expandSegments(currentPath: string, segments: string[]): string[] {
  if (segments.length === 0) {
    if (!existsSync(currentPath)) {
      return [];
    }

    try {
      return statSync(currentPath).isFile() ? [resolve(currentPath)] : [];
    } catch {
      return [];
    }
  }

  const [segment, ...rest] = segments;

  if (segment === undefined) {
    return [];
  }

  if (segment === "*") {
    if (!existsSync(currentPath)) {
      return [];
    }

    try {
      if (!statSync(currentPath).isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }

    return readdirSync(currentPath).flatMap((entryName) =>
      expandSegments(join(currentPath, entryName), rest)
    );
  }

  return expandSegments(join(currentPath, segment), rest);
}

export function enumeratePaths(
  homeDir: string
): { surface: HostMemorySurface; path: string; parser: PathSpec["parser"] }[] {
  const discovered = new Map<
    string,
    { surface: HostMemorySurface; path: string; parser: PathSpec["parser"] }
  >();

  for (const spec of HOST_MEMORY_FILE_PATH_SPECS) {
    for (const path of expandPattern(homeDir, spec.pattern)) {
      discovered.set(path, {
        surface: spec.surface,
        path,
        parser: spec.parser
      });
    }
  }

  return [...discovered.values()].sort((left, right) => left.path.localeCompare(right.path));
}
