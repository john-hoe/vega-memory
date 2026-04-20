import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { createLogger, type Logger } from "../core/logging/index.js";

const logger = createLogger({ name: "backup-registry" });

export const DEFAULT_BACKUP_CONFIG_PATH = resolve(process.cwd(), "docs/backups/backup-config.yaml");
export const DEFAULT_BACKUP_CONFIG = {
  targets: [],
  retention: {
    max_count: 7,
    min_days: 1
  },
  exclude_globs: [],
  scheduler: {
    enabled: false,
    interval_ms: 86_400_000
  }
} as const;

const RetentionSchema = z.object({
  max_count: z.number().int().gt(0).default(DEFAULT_BACKUP_CONFIG.retention.max_count),
  min_days: z.number().int().gte(0).default(DEFAULT_BACKUP_CONFIG.retention.min_days)
});

const SchedulerSchema = z.object({
  enabled: z.boolean().default(DEFAULT_BACKUP_CONFIG.scheduler.enabled),
  interval_ms: z.number().int().gt(0).default(DEFAULT_BACKUP_CONFIG.scheduler.interval_ms)
});

export const BackupConfigSchema = z.object({
  targets: z.array(z.string().trim().min(1)).default([...DEFAULT_BACKUP_CONFIG.targets]),
  retention: RetentionSchema.default(DEFAULT_BACKUP_CONFIG.retention),
  exclude_globs: z.array(z.string().trim().min(1)).default([...DEFAULT_BACKUP_CONFIG.exclude_globs]),
  scheduler: SchedulerSchema.default(DEFAULT_BACKUP_CONFIG.scheduler)
});

export type BackupConfig = z.infer<typeof BackupConfigSchema>;

interface ParsedLine {
  indent: number;
  content: string;
  lineNumber: number;
}

const cloneDefaultConfig = (): BackupConfig => ({
  targets: [...DEFAULT_BACKUP_CONFIG.targets],
  retention: { ...DEFAULT_BACKUP_CONFIG.retention },
  exclude_globs: [...DEFAULT_BACKUP_CONFIG.exclude_globs],
  scheduler: { ...DEFAULT_BACKUP_CONFIG.scheduler }
});

const toParseError = (message: string, lineNumber: number): Error =>
  new Error(`YAML parse error on line ${lineNumber}: ${message}`);

const splitKeyValue = (content: string, lineNumber: number): [string, string] => {
  const separatorIndex = content.indexOf(":");

  if (separatorIndex < 0) {
    throw toParseError("Expected key:value pair.", lineNumber);
  }

  const key = content.slice(0, separatorIndex).trim();
  const value = content.slice(separatorIndex + 1).trim();

  if (key.length === 0) {
    throw toParseError("Expected a key before ':'.", lineNumber);
  }

  return [key, value];
};

const parseScalar = (value: string): string | number | boolean => {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^-?\d+$/u.test(value)) {
    return Number.parseInt(value, 10);
  }

  return value;
};

const parseBackupConfigYaml = (source: string): unknown => {
  const lines: ParsedLine[] = source
    .split(/\r?\n/u)
    .map((rawLine, index) => ({
      indent: rawLine.match(/^ */u)?.[0].length ?? 0,
      content: rawLine.trim(),
      lineNumber: index + 1
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));

  if (lines.length === 0) {
    return {};
  }

  const config: Record<string, unknown> = {};
  let currentList: "targets" | "exclude_globs" | null = null;
  let currentObject: "retention" | "scheduler" | null = null;

  for (const line of lines) {
    if (line.indent % 2 !== 0) {
      throw toParseError("Indentation must use multiples of 2 spaces.", line.lineNumber);
    }

    if (line.indent === 0) {
      const [key, value] = splitKeyValue(line.content, line.lineNumber);
      if (key === "targets" || key === "exclude_globs") {
        currentList = key;
        currentObject = null;
        if (value === "[]") {
          config[key] = [];
          currentList = null;
          continue;
        }

        if (value.length > 0) {
          throw toParseError(`${key} must be declared as a block list or [].`, line.lineNumber);
        }

        config[key] = [];
        continue;
      }

      if (key === "retention" || key === "scheduler") {
        currentObject = key;
        currentList = null;
        if (value.length > 0) {
          throw toParseError(`${key} must be declared as a block object.`, line.lineNumber);
        }

        config[key] = {};
        continue;
      }

      config[key] = parseScalar(value);
      currentList = null;
      currentObject = null;
      continue;
    }

    if (line.indent === 2 && currentList !== null) {
      if (!line.content.startsWith("-")) {
        throw toParseError(`Expected a list item under ${currentList}.`, line.lineNumber);
      }

      const value = line.content.slice(1).trim();
      if (value.length === 0) {
        throw toParseError("List items must not be empty.", line.lineNumber);
      }

      (config[currentList] as unknown[]).push(parseScalar(value));
      continue;
    }

    if (line.indent === 2 && currentObject !== null) {
      const [key, value] = splitKeyValue(line.content, line.lineNumber);
      (config[currentObject] as Record<string, unknown>)[key] = parseScalar(value);
      continue;
    }

    throw toParseError("Unsupported indentation or structure.", line.lineNumber);
  }

  return config;
};

export const expandPlaceholders = (value: string, env: NodeJS.ProcessEnv = process.env): string =>
  value.replace(/\$\{([^}]+)\}/gu, (_match, key: string) => env[key] ?? "");

export function loadBackupConfig(
  path: string,
  options: {
    env?: NodeJS.ProcessEnv;
    logger?: Logger;
  } = {}
): BackupConfig {
  const env = options.env ?? process.env;
  const activeLogger = options.logger ?? logger;

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = BackupConfigSchema.parse(parseBackupConfigYaml(raw));

    return {
      ...parsed,
      targets: parsed.targets.map((target) => expandPlaceholders(target, env))
    };
  } catch (error) {
    activeLogger.warn("Falling back to default backup config.", {
      path,
      error: error instanceof Error ? error.message : String(error)
    });
    return cloneDefaultConfig();
  }
}
