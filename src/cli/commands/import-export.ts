import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { Command, InvalidArgumentError, Option } from "commander";

import type { VegaConfig } from "../../config.js";
import { buildSourceContext } from "../../core/device.js";
import { ARCHIVED_EXPORT_METADATA_KEY } from "../../core/lifecycle.js";
import { MemoryService } from "../../core/memory.js";
import type {
  AuditContext,
  Memory,
  MemoryScope,
  MemorySource,
  MemorySourceContext,
  MemoryStatus,
  MemoryType,
  VerifiedStatus
} from "../../core/types.js";
import type { Repository } from "../../db/repository.js";
import { decryptBuffer, encryptBuffer } from "../../security/encryption.js";
import { requireConfiguredEncryptionKey } from "../../security/keychain.js";

interface PortableMemory {
  id?: string;
  content: string;
  summary?: string | null;
  type: MemoryType;
  project: string;
  title?: string;
  tags?: string[];
  importance?: number;
  source?: MemorySource;
  embedding?: string | null;
  created_at?: string;
  updated_at?: string;
  accessed_at?: string;
  access_count?: number;
  status?: MemoryStatus;
  verified?: VerifiedStatus;
  scope?: MemoryScope;
  accessed_projects?: string[];
  source_context?: MemorySourceContext | null;
}

interface PortableExportPayload {
  format: "vega-memory/v1";
  exported_at: string;
  memories: PortableMemory[];
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
const MEMORY_STATUSES = ["active", "archived"] as const satisfies readonly MemoryStatus[];
const VERIFIED_STATUSES = [
  "verified",
  "unverified",
  "rejected",
  "conflict"
] as const satisfies readonly VerifiedStatus[];
const MEMORY_SCOPES = ["project", "global"] as const satisfies readonly MemoryScope[];
const ENTRY_START = "<!-- vega-memory-entry:start -->";
const ENTRY_END = "<!-- vega-memory-entry:end -->";
const DAY_MS = 24 * 60 * 60 * 1000;
const CLI_AUDIT_CONTEXT: AuditContext = { actor: "cli", ip: null };

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

const validateStatus = (value: unknown): MemoryStatus | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !MEMORY_STATUSES.includes(value as MemoryStatus)) {
    throw new Error(`Invalid memory status: ${String(value)}`);
  }

  return value as MemoryStatus;
};

const validateVerified = (value: unknown): VerifiedStatus | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !VERIFIED_STATUSES.includes(value as VerifiedStatus)) {
    throw new Error(`Invalid verification status: ${String(value)}`);
  }

  return value as VerifiedStatus;
};

const validateScope = (value: unknown): MemoryScope | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !MEMORY_SCOPES.includes(value as MemoryScope)) {
    throw new Error(`Invalid memory scope: ${String(value)}`);
  }

  return value as MemoryScope;
};

const validateTimestamp = (value: unknown, field: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }

  return value;
};

const validateStringArray = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Invalid ${field}`);
  }

  return value;
};

const validateEmbedding = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null) {
    return value as string | null | undefined;
  }

  if (typeof value !== "string") {
    throw new Error("Invalid embedding");
  }

  return value;
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

  const tags = validateStringArray(candidate.tags, "tags");
  const importance =
    typeof candidate.importance === "number" && Number.isFinite(candidate.importance)
      ? candidate.importance
      : undefined;
  const title =
    typeof candidate.title === "string" && candidate.title.trim().length > 0
      ? candidate.title
      : undefined;
  const summary =
    candidate.summary === null || typeof candidate.summary === "string"
      ? candidate.summary
      : undefined;

  return {
    content: candidate.content,
    summary,
    type: validateType(candidate.type),
    project: candidate.project,
    id: typeof candidate.id === "string" && candidate.id.trim().length > 0 ? candidate.id : undefined,
    title,
    tags,
    importance,
    source: validateSource(candidate.source),
    embedding: validateEmbedding(candidate.embedding),
    created_at: validateTimestamp(candidate.created_at, "created_at"),
    updated_at: validateTimestamp(candidate.updated_at, "updated_at"),
    accessed_at: validateTimestamp(candidate.accessed_at, "accessed_at"),
    access_count:
      typeof candidate.access_count === "number" &&
      Number.isInteger(candidate.access_count) &&
      candidate.access_count >= 0
        ? candidate.access_count
        : undefined,
    status: validateStatus(candidate.status),
    verified: validateVerified(candidate.verified),
    scope: validateScope(candidate.scope),
    accessed_projects: validateStringArray(candidate.accessed_projects, "accessed_projects"),
    source_context:
      candidate.source_context === undefined || candidate.source_context === null
        ? (candidate.source_context as null | undefined)
        : typeof candidate.source_context === "object"
          ? (candidate.source_context as MemorySourceContext)
          : undefined
  };
};

const serializePortableMemory = (memory: Memory): PortableMemory => ({
  id: memory.id,
  content: memory.content,
  summary: memory.summary,
  type: memory.type,
  project: memory.project,
  title: memory.title,
  tags: memory.tags,
  importance: memory.importance,
  source: memory.source,
  embedding: memory.embedding?.toString("base64") ?? null,
  created_at: memory.created_at,
  updated_at: memory.updated_at,
  accessed_at: memory.accessed_at,
  access_count: memory.access_count,
  status: memory.status,
  verified: memory.verified,
  scope: memory.scope,
  accessed_projects: memory.accessed_projects,
  source_context: memory.source_context ?? null
});

const isLosslessPortableMemory = (memory: PortableMemory): boolean =>
  memory.id !== undefined ||
  memory.embedding !== undefined ||
  memory.created_at !== undefined ||
  memory.updated_at !== undefined ||
  memory.accessed_at !== undefined ||
  memory.access_count !== undefined ||
  memory.status !== undefined ||
  memory.verified !== undefined ||
  memory.scope !== undefined ||
  memory.accessed_projects !== undefined;

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

const renderJson = (memories: PortableMemory[]): string =>
  JSON.stringify(
    {
      format: "vega-memory/v1",
      exported_at: new Date().toISOString(),
      memories
    } satisfies PortableExportPayload,
    null,
    2
  );

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

const buildImportedMemory = (entry: PortableMemory): Memory | null => {
  if (!isLosslessPortableMemory(entry) || entry.id === undefined) {
    return null;
  }

  const timestamp = new Date().toISOString();
  const source = entry.source ?? "auto";
  const title = entry.title?.trim() || entry.content.trim().split(/\r?\n/, 1)[0] || "Untitled Memory";

  return {
    id: entry.id,
    type: entry.type,
    project: entry.project,
    title,
    content: entry.content,
    summary: entry.summary ?? null,
    embedding: entry.embedding ? Buffer.from(entry.embedding, "base64") : null,
    importance: entry.importance ?? 0.5,
    source,
    tags: entry.tags ?? [],
    created_at: entry.created_at ?? timestamp,
    updated_at: entry.updated_at ?? timestamp,
    accessed_at: entry.accessed_at ?? entry.updated_at ?? entry.created_at ?? timestamp,
    access_count: entry.access_count ?? 0,
    status: entry.status ?? "active",
    verified: entry.verified ?? (source === "explicit" ? "verified" : "unverified"),
    scope: entry.scope ?? (entry.type === "preference" ? "global" : "project"),
    accessed_projects: entry.accessed_projects ?? [entry.project],
    source_context: entry.source_context ?? null
  };
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
            ? renderJson(memories)
            : renderMarkdown(memories);

        if (options.output) {
          const outputPath = resolve(options.output);

          if (options.encrypt) {
            writeFileSync(
              outputPath,
              encryptBuffer(
                Buffer.from(rendered, "utf8"),
                await requireConfiguredEncryptionKey(config)
              )
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
              await requireConfiguredEncryptionKey(config)
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
        const importedMemory = buildImportedMemory(entry);

        if (importedMemory === null) {
          await memoryService.store({
            content: entry.content,
            type: entry.type,
            project: entry.project,
            title: entry.title,
            tags: entry.tags,
            importance: entry.importance,
            source: entry.source,
            auditContext: CLI_AUDIT_CONTEXT,
            sourceContext:
              entry.source_context ??
              buildSourceContext("user", "cli", {
                surface: "cli",
                integration: "vega-cli"
              })
          });
          continue;
        }

        const existing = repository.getMemory(importedMemory.id);

        if (existing === null) {
          repository.createMemory({
            id: importedMemory.id,
            type: importedMemory.type,
            project: importedMemory.project,
            title: importedMemory.title,
            content: importedMemory.content,
            summary: importedMemory.summary,
            embedding: importedMemory.embedding,
            importance: importedMemory.importance,
            source: importedMemory.source,
            tags: importedMemory.tags,
            created_at: importedMemory.created_at,
            updated_at: importedMemory.updated_at,
            accessed_at: importedMemory.accessed_at,
            status: importedMemory.status,
            verified: importedMemory.verified,
            scope: importedMemory.scope,
            accessed_projects: importedMemory.accessed_projects,
            source_context: importedMemory.source_context
          }, CLI_AUDIT_CONTEXT);
        }

        repository.updateMemory(
          importedMemory.id,
          {
            type: importedMemory.type,
            project: importedMemory.project,
            title: importedMemory.title,
            content: importedMemory.content,
            embedding: importedMemory.embedding,
            importance: importedMemory.importance,
            source: importedMemory.source,
            tags: importedMemory.tags,
            created_at: importedMemory.created_at,
            updated_at: importedMemory.updated_at,
            accessed_at: importedMemory.accessed_at,
            access_count: importedMemory.access_count,
            status: importedMemory.status,
            verified: importedMemory.verified,
            scope: importedMemory.scope,
            accessed_projects: importedMemory.accessed_projects,
            source_context: importedMemory.source_context
          },
          {
            skipVersion: true,
            auditContext: CLI_AUDIT_CONTEXT
          }
        );
      }

      console.log(`imported ${entries.length} memories from ${inputPath}`);
    });
}
