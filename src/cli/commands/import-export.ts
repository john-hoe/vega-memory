import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { Command, InvalidArgumentError, Option } from "commander";

import type { VegaConfig } from "../../config.js";
import { ARCHIVED_EXPORT_METADATA_KEY } from "../../core/lifecycle.js";
import { MemoryService } from "../../core/memory.js";
import type { Memory, MemorySource, MemoryType } from "../../core/types.js";
import type { Repository } from "../../db/repository.js";
import { decryptBuffer, encryptBuffer } from "../../security/encryption.js";
import {
  VEGA_ENCRYPTION_ACCOUNT,
  VEGA_KEYCHAIN_SERVICE,
  getKey
} from "../../security/keychain.js";

interface PortableMemory {
  content: string;
  type: MemoryType;
  project: string;
  title?: string;
  tags?: string[];
  importance?: number;
  source?: MemorySource;
}

const MEMORY_TYPES = [
  "task_state",
  "preference",
  "project_context",
  "decision",
  "pitfall",
  "insight"
] as const satisfies readonly MemoryType[];

const MEMORY_SOURCES = ["auto", "explicit"] as const satisfies readonly MemorySource[];
const ENTRY_START = "<!-- vega-memory-entry:start -->";
const ENTRY_END = "<!-- vega-memory-entry:end -->";
const DAY_MS = 24 * 60 * 60 * 1000;

const validateType = (value: unknown): MemoryType => {
  if (typeof value !== "string" || !MEMORY_TYPES.includes(value as MemoryType)) {
    throw new Error(`Invalid memory type: ${String(value)}`);
  }

  return value as MemoryType;
};

const validateSource = (value: unknown): MemorySource | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !MEMORY_SOURCES.includes(value as MemorySource)) {
    throw new Error(`Invalid memory source: ${String(value)}`);
  }

  return value as MemorySource;
};

const validatePortableMemory = (value: unknown): PortableMemory => {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid memory entry");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.content !== "string" || candidate.content.trim().length === 0) {
    throw new Error("Memory entry is missing content");
  }
  if (typeof candidate.project !== "string" || candidate.project.trim().length === 0) {
    throw new Error("Memory entry is missing project");
  }

  const tags =
    Array.isArray(candidate.tags) && candidate.tags.every((tag) => typeof tag === "string")
      ? candidate.tags
      : undefined;
  const importance =
    typeof candidate.importance === "number" && Number.isFinite(candidate.importance)
      ? candidate.importance
      : undefined;
  const title =
    typeof candidate.title === "string" && candidate.title.trim().length > 0
      ? candidate.title
      : undefined;

  return {
    content: candidate.content,
    type: validateType(candidate.type),
    project: candidate.project,
    title,
    tags,
    importance,
    source: validateSource(candidate.source)
  };
};

const serializePortableMemory = (memory: Memory): PortableMemory => ({
  content: memory.content,
  type: memory.type,
  project: memory.project,
  title: memory.title,
  tags: memory.tags,
  importance: memory.importance,
  source: memory.source
});

const renderMarkdown = (memories: PortableMemory[]): string => {
  const blocks = memories.map((memory) => {
    const lines = [
      ENTRY_START,
      `## ${memory.title ?? "Untitled Memory"}`,
      `type: ${memory.type}`,
      `project: ${memory.project}`,
      `tags: ${(memory.tags ?? []).join(", ")}`,
      `importance: ${memory.importance ?? ""}`,
      `source: ${memory.source ?? "auto"}`,
      "",
      memory.content.trimEnd(),
      ENTRY_END
    ];

    return lines.join("\n");
  });

  return ["# Vega Memory Export", "", ...blocks].join("\n\n");
};

const parseMarkdownBlock = (block: string): PortableMemory => {
  const lines = block
    .trim()
    .split(/\r?\n/);
  const titleLine = lines.shift();

  if (!titleLine || !titleLine.startsWith("## ")) {
    throw new Error("Markdown entry is missing a title heading");
  }

  const metadata = new Map<string, string>();

  while (lines.length > 0) {
    const line = lines[0]?.trim() ?? "";
    if (line.length === 0) {
      lines.shift();
      break;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid markdown metadata line: ${line}`);
    }

    metadata.set(
      line.slice(0, separatorIndex).trim(),
      line.slice(separatorIndex + 1).trim()
    );
    lines.shift();
  }

  const content = lines.join("\n").trim();
  const importanceValue = metadata.get("importance");
  const tagsValue = metadata.get("tags");
  const sourceValue = metadata.get("source");

  return validatePortableMemory({
    title: titleLine.slice(3).trim(),
    type: metadata.get("type"),
    project: metadata.get("project"),
    tags: tagsValue ? tagsValue.split(",").map((tag) => tag.trim()).filter(Boolean) : undefined,
    importance:
      importanceValue && importanceValue.length > 0 ? Number(importanceValue) : undefined,
    source: sourceValue && sourceValue.length > 0 ? sourceValue : undefined,
    content
  });
};

const parseMarkdown = (content: string): PortableMemory[] => {
  const entries = [...content.matchAll(new RegExp(`${ENTRY_START}([\\s\\S]*?)${ENTRY_END}`, "g"))].map(
    (match) => parseMarkdownBlock(match[1] ?? "")
  );

  if (entries.length === 0) {
    throw new Error("No markdown entries found");
  }

  return entries;
};

const parseJson = (content: string): PortableMemory[] => {
  const parsed = JSON.parse(content) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { memories?: unknown[] }).memories)
      ? (parsed as { memories: unknown[] }).memories
      : [parsed];

  return entries.map(validatePortableMemory);
};

const inferFormat = (output?: string): "json" | "md" => {
  if (!output) {
    return "json";
  }

  const extension = extname(output).toLowerCase();
  return extension === ".md" || extension === ".markdown" ? "md" : "json";
};

const parseFormat = (value: string): "json" | "md" => {
  if (value !== "json" && value !== "md") {
    throw new InvalidArgumentError("format must be json or md");
  }

  return value;
};

const parseBefore = (value: string): string => {
  const trimmed = value.trim();
  const relativeMatch = /^(\d+)d$/i.exec(trimmed);

  if (relativeMatch) {
    return new Date(Date.now() - Number(relativeMatch[1]) * DAY_MS).toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new InvalidArgumentError("before must be an ISO date or Nd");
  }

  return new Date(parsed).toISOString();
};

const resolveEncryptionKey = async (config: VegaConfig): Promise<string> => {
  if (config.encryptionKey !== undefined) {
    return config.encryptionKey;
  }

  const key = await getKey(VEGA_KEYCHAIN_SERVICE, VEGA_ENCRYPTION_ACCOUNT);
  if (key !== null) {
    return key;
  }

  throw new Error("Encryption key not configured. Set VEGA_ENCRYPTION_KEY or run `vega init-encryption`.");
};

export function registerImportExportCommands(
  program: Command,
  repository: Repository,
  memoryService: MemoryService,
  config: VegaConfig
): void {
  program
    .command("export")
    .description("Export memories as JSON or markdown")
    .addOption(new Option("--format <format>", "export format").argParser(parseFormat))
    .option("--project <project>", "project name")
    .addOption(new Option("--type <type>", "memory type").choices([...MEMORY_TYPES]))
    .option("--archived", "export archived memories only")
    .option("--before <date>", "only include memories updated before the given ISO date or Nd", parseBefore)
    .option("--encrypt", "encrypt JSON export output")
    .option("-o, --output <output>", "output file")
    .action(
      async (options: {
        format?: "json" | "md";
        project?: string;
        type?: MemoryType;
        archived?: boolean;
        before?: string;
        encrypt?: boolean;
        output?: string;
      }) => {
        const format = options.format ?? inferFormat(options.output);
        if (options.encrypt && format !== "json") {
          throw new Error("Encrypted export only supports JSON format");
        }
        if (options.encrypt && !options.output) {
          throw new Error("Encrypted export requires --output");
        }

        const memories = repository
          .listMemories({
            project: options.project,
            type: options.type,
            status: options.archived ? "archived" : undefined,
            limit: 1_000_000,
            sort: "created_at DESC"
          })
          .filter((memory) => {
            if (options.before === undefined) {
              return true;
            }

            return Date.parse(memory.updated_at) <= Date.parse(options.before);
          })
          .map(serializePortableMemory);
        const rendered =
          format === "json"
            ? JSON.stringify(memories, null, 2)
            : renderMarkdown(memories);

        if (options.output) {
          const outputPath = resolve(options.output);

          if (options.encrypt) {
            writeFileSync(
              outputPath,
              encryptBuffer(Buffer.from(rendered, "utf8"), await resolveEncryptionKey(config))
            );
          } else {
            writeFileSync(outputPath, rendered, "utf8");
          }

          if (options.archived) {
            repository.setMetadata(ARCHIVED_EXPORT_METADATA_KEY, new Date().toISOString());
          }
          console.log(`exported ${memories.length} memories to ${outputPath}`);
          return;
        }

        if (options.archived) {
          repository.setMetadata(ARCHIVED_EXPORT_METADATA_KEY, new Date().toISOString());
        }
        console.log(rendered);
      }
    );

  program
    .command("import")
    .description("Import memories from JSON or markdown")
    .argument("<file>", "input file")
    .option("--decrypt", "decrypt JSON input before import")
    .action(async (file: string, options: { decrypt?: boolean }) => {
      const inputPath = resolve(file);
      const entries = options.decrypt
        ? parseJson(
            decryptBuffer(
              readFileSync(inputPath),
              await resolveEncryptionKey(config)
            ).toString("utf8")
          )
        : (() => {
            const content = readFileSync(inputPath, "utf8");
            const extension = extname(inputPath).toLowerCase();

            return extension === ".json"
              ? parseJson(content)
              : extension === ".md" || extension === ".markdown"
                ? parseMarkdown(content)
                : (() => {
                    try {
                      return parseJson(content);
                    } catch {
                      return parseMarkdown(content);
                    }
                  })();
          })();

      for (const entry of entries) {
        await memoryService.store(entry);
      }

      console.log(`imported ${entries.length} memories from ${inputPath}`);
    });
}
