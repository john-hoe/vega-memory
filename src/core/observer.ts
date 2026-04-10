import { basename } from "node:path";

import type { VegaConfig } from "../config.js";
import type { StoreResult } from "./types.js";
import { buildSourceContext } from "./device.js";
import { MemoryService } from "./memory.js";

const SHELL_TOOL_PATTERN = /(^|[_\s-])(shell|bash|zsh|terminal|exec)([_\s-]|$)/i;
const FILE_WRITE_TOOL_PATTERN =
  /(^|[_\s-])(write|edit|patch|save|update_file|create_file|apply_patch|replace_content|update_content)([_\s-]|$)/i;
const READ_ONLY_TOOL_PATTERN = /(^|[_\s-])(read|open|find|search|list|view|screenshot|click|navigate)([_\s-]|$)/i;
const ERROR_PATTERN =
  /(?:^|\b)(error|failed|failure|exception|traceback|permission denied|enoent|eacces)\b/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const getString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const getNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;

const getErrorSnippet = (text: string): string | null => {
  const match = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => ERROR_PATTERN.test(line));

  return match ? truncate(match, 240) : null;
};

export class ObserverService {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly config: VegaConfig
  ) {}

  shouldObserve(toolName: string): boolean {
    if (READ_ONLY_TOOL_PATTERN.test(toolName)) {
      return false;
    }

    return SHELL_TOOL_PATTERN.test(toolName) || FILE_WRITE_TOOL_PATTERN.test(toolName);
  }

  async observeToolOutput(
    toolName: string,
    input: unknown,
    output: unknown,
    project: string
  ): Promise<string | null> {
    if (!this.config.observerEnabled || !this.shouldObserve(toolName)) {
      return null;
    }

    if (SHELL_TOOL_PATTERN.test(toolName)) {
      const stored = await this.observeShellFailure(input, output, project);
      if (stored !== null) {
        return stored;
      }
    }

    if (FILE_WRITE_TOOL_PATTERN.test(toolName)) {
      const stored = await this.observeFileWrite(input, project);
      if (stored !== null) {
        return stored;
      }
    }

    return this.observeErrorPattern(output, project);
  }

  private async observeShellFailure(
    input: unknown,
    output: unknown,
    project: string
  ): Promise<string | null> {
    if (!isRecord(output)) {
      return null;
    }

    const exitCode = getNumber(output, "exitCode") ?? getNumber(output, "exit_code");
    if (exitCode === undefined || exitCode === 0) {
      return null;
    }

    const command =
      (isRecord(input) ? getString(input, "cmd") : undefined) ??
      (isRecord(output) ? getString(output, "command") : undefined) ??
      "shell command";
    const errorSnippet =
      getErrorSnippet(toText(output)) ?? truncate(toText(output), 240);

    const result = await this.memoryService.store({
      content: `Shell command failed: ${command}\nExit code: ${exitCode}\nError: ${errorSnippet}`,
      type: "pitfall",
      project,
      title: `Shell failure: ${truncate(command, 80)}`,
      tags: ["shell", "error", "failure"],
      source: "auto",
      skipSimilarityCheck: true,
      sourceContext: buildSourceContext("observer", "internal")
    });

    return this.toStoredId(result);
  }

  private async observeErrorPattern(output: unknown, project: string): Promise<string | null> {
    const errorSnippet = getErrorSnippet(toText(output));
    if (errorSnippet === null) {
      return null;
    }

    const result = await this.memoryService.store({
      content: `Observed recurring error pattern: ${errorSnippet}`,
      type: "pitfall",
      project,
      title: truncate(errorSnippet, 80),
      tags: ["error-pattern"],
      source: "auto",
      sourceContext: buildSourceContext("observer", "internal")
    });

    return this.toStoredId(result);
  }

  private async observeFileWrite(input: unknown, project: string): Promise<string | null> {
    if (!isRecord(input)) {
      return null;
    }

    const filePath = getString(input, "path") ?? getString(input, "file");
    if (filePath === undefined) {
      return null;
    }

    const content = getString(input, "content") ?? getString(input, "new_str") ?? "";
    const firstLine = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    const purpose = firstLine ?? "updated during tool execution";
    const result = await this.memoryService.store({
      content: `File ${filePath} was written or edited for: ${purpose}`,
      type: "project_context",
      project,
      title: `File update: ${basename(filePath)}`,
      tags: ["file", "write", basename(filePath).toLowerCase()],
      source: "auto",
      skipSimilarityCheck: true,
      sourceContext: buildSourceContext("observer", "internal")
    });

    return this.toStoredId(result);
  }

  private toStoredId(result: StoreResult): string | null {
    return result.id.trim().length > 0 ? result.id : null;
  }
}
