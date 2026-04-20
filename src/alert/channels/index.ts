import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { createLogger } from "../../core/logging/index.js";

import {
  createSlackChannel,
  type CreateSlackChannelOptions
} from "./slack.js";
import {
  createTelegramChannel,
  type CreateTelegramChannelOptions
} from "./telegram.js";
import {
  createWebhookChannel,
  type AlertChannel,
  type AlertDispatchResult,
  type AlertPayload,
  type CreateWebhookChannelOptions
} from "./webhook.js";

const logger = createLogger({ name: "alert-channels" });

export { createSlackChannel, createTelegramChannel, createWebhookChannel };
export type {
  AlertChannel,
  AlertDispatchResult,
  AlertPayload,
  CreateSlackChannelOptions,
  CreateTelegramChannelOptions,
  CreateWebhookChannelOptions
};

export const DEFAULT_ALERT_CHANNELS_PATH = resolve(process.cwd(), "docs/alerts/channels.yaml");

const AlertChannelIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9_-]+$/u);

const AlertChannelWebhookSchema = z.object({
  id: AlertChannelIdSchema,
  type: z.literal("webhook"),
  enabled: z.boolean().default(true),
  config: z.object({
    url: z.string().trim().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    method: z.literal("POST").optional()
  })
});

const AlertChannelSlackSchema = z.object({
  id: AlertChannelIdSchema,
  type: z.literal("slack"),
  enabled: z.boolean().default(true),
  config: z.object({
    url: z.string().trim().min(1)
  })
});

const AlertChannelTelegramSchema = z.object({
  id: AlertChannelIdSchema,
  type: z.literal("telegram"),
  enabled: z.boolean().default(true),
  config: z.object({
    bot_token: z.string().trim().min(1),
    chat_id: z.string().trim().min(1)
  })
});

const AlertChannelDefinitionSchema = z.discriminatedUnion("type", [
  AlertChannelWebhookSchema,
  AlertChannelSlackSchema,
  AlertChannelTelegramSchema
]);

const AlertChannelsSchema = z.object({
  channels: z.array(AlertChannelDefinitionSchema)
});

type AlertChannelDefinition = z.infer<typeof AlertChannelDefinitionSchema>;
export type AlertChannelsDegraded = "missing" | "parse_error";

export interface AlertChannelsLoadResult {
  path: string;
  channels: AlertChannel[];
  degraded?: AlertChannelsDegraded;
}

interface ParsedLine {
  indent: number;
  content: string;
  lineNumber: number;
}

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

  if (/^-?\d+(?:\.\d+)?$/u.test(value)) {
    return Number(value);
  }

  return value;
};

const expandEnvPlaceholders = (value: unknown, env: Record<string, string | undefined>): unknown => {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/giu, (_match, variableName: string) => {
      return env[variableName] ?? "";
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, env));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, expandEnvPlaceholders(entry, env)])
    );
  }

  return value;
};

const parseChannelsYaml = (source: string): unknown => {
  const lines: ParsedLine[] = source
    .split(/\r?\n/u)
    .map((rawLine, index) => ({
      indent: rawLine.match(/^ */u)?.[0].length ?? 0,
      content: rawLine.trim(),
      lineNumber: index + 1
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));

  if (lines.length === 0) {
    throw toParseError("Expected a channels root key.", 1);
  }

  const firstLine = lines[0];
  if (firstLine.indent !== 0 || !firstLine.content.startsWith("channels:")) {
    throw toParseError("Registry must start with 'channels:'.", firstLine.lineNumber);
  }

  const rootValue = firstLine.content.slice("channels:".length).trim();
  if (rootValue === "[]") {
    return { channels: [] };
  }

  if (rootValue.length > 0) {
    throw toParseError("channels must be declared as a block list or [].", firstLine.lineNumber);
  }

  const channels: Array<Record<string, unknown>> = [];
  let currentChannel: Record<string, unknown> | null = null;
  let currentSection: "config" | null = null;
  let currentConfigMap: Record<string, unknown> | null = null;

  for (const line of lines.slice(1)) {
    if (line.indent % 2 !== 0) {
      throw toParseError("Indentation must use multiples of 2 spaces.", line.lineNumber);
    }

    if (line.indent === 2) {
      if (!line.content.startsWith("-")) {
        throw toParseError("Expected a list item under channels.", line.lineNumber);
      }

      currentChannel = {};
      channels.push(currentChannel);
      currentSection = null;
      currentConfigMap = null;

      const itemContent = line.content.slice(1).trim();
      if (itemContent.length === 0) {
        continue;
      }

      const [key, value] = splitKeyValue(itemContent, line.lineNumber);
      currentChannel[key] = parseScalar(value);
      continue;
    }

    if (currentChannel === null) {
      throw toParseError("Channel entries must appear under a list item.", line.lineNumber);
    }

    if (line.indent === 4) {
      if (line.content.endsWith(":")) {
        const key = line.content.slice(0, -1).trim();

        if (key !== "config") {
          throw toParseError(`Unknown nested section '${key}'.`, line.lineNumber);
        }

        currentSection = "config";
        currentConfigMap = {};
        currentChannel.config = currentConfigMap;
        continue;
      }

      const [key, value] = splitKeyValue(line.content, line.lineNumber);
      currentChannel[key] = parseScalar(value);
      currentSection = null;
      currentConfigMap = null;
      continue;
    }

    if (line.indent === 6) {
      if (currentSection !== "config" || currentConfigMap === null) {
        throw toParseError("Unexpected indentation level.", line.lineNumber);
      }

      if (line.content.endsWith(":")) {
        const key = line.content.slice(0, -1).trim();

        if (key !== "headers") {
          throw toParseError(`Unknown config block '${key}'.`, line.lineNumber);
        }

        currentConfigMap.headers = {};
        continue;
      }

      const [key, value] = splitKeyValue(line.content, line.lineNumber);
      currentConfigMap[key] = parseScalar(value);
      continue;
    }

    if (line.indent === 8) {
      const headers = currentConfigMap?.headers;
      if (currentSection !== "config" || headers === undefined || typeof headers !== "object") {
        throw toParseError("Nested values are only supported under config.headers.", line.lineNumber);
      }

      const [key, value] = splitKeyValue(line.content, line.lineNumber);
      (headers as Record<string, unknown>)[key] = String(parseScalar(value));
      continue;
    }

    throw toParseError("Unsupported indentation depth.", line.lineNumber);
  }

  return { channels };
};

const instantiateAlertChannels = (definitions: AlertChannelDefinition[]): AlertChannel[] =>
  definitions
    .filter((definition) => definition.enabled !== false)
    .map((definition) => {
      switch (definition.type) {
        case "webhook":
          return createWebhookChannel({
            id: definition.id,
            url: definition.config.url,
            headers: definition.config.headers,
            method: definition.config.method
          });
        case "slack":
          return createSlackChannel({
            id: definition.id,
            url: definition.config.url
          });
        case "telegram":
          return createTelegramChannel({
            id: definition.id,
            botToken: definition.config.bot_token,
            chatId: definition.config.chat_id
          });
      }
    });

export function inspectAlertChannels(
  path = DEFAULT_ALERT_CHANNELS_PATH,
  env: Record<string, string | undefined> = process.env
): AlertChannelsLoadResult {
  const resolvedPath = resolve(path);

  let source: string;
  try {
    source = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.warn("Alert channels file is missing.", {
        path: resolvedPath
      });
      return {
        path: resolvedPath,
        channels: [],
        degraded: "missing"
      };
    }

    logger.warn("Failed to read alert channels.", {
      path: resolvedPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      path: resolvedPath,
      channels: [],
      degraded: "parse_error"
    };
  }

  try {
    const parsed = parseChannelsYaml(source);
    const expanded = expandEnvPlaceholders(parsed, env);
    const validated = AlertChannelsSchema.safeParse(expanded);

    if (!validated.success) {
      logger.warn("Alert channels validation failed.", {
        path: resolvedPath,
        error: z.prettifyError(validated.error)
      });
      return {
        path: resolvedPath,
        channels: [],
        degraded: "parse_error"
      };
    }

    return {
      path: resolvedPath,
      channels: instantiateAlertChannels(validated.data.channels)
    };
  } catch (error) {
    logger.warn("Alert channels parse failed.", {
      path: resolvedPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      path: resolvedPath,
      channels: [],
      degraded: "parse_error"
    };
  }
}

export function loadAlertChannels(
  path = DEFAULT_ALERT_CHANNELS_PATH,
  env: Record<string, string | undefined> = process.env
): AlertChannel[] {
  return inspectAlertChannels(path, env).channels;
}
