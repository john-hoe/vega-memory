import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";
import { createLogger, type Logger } from "../core/logging/index.js";

import { DEFAULT_FEATURE_FLAG_REGISTRY_PATH } from "./runtime.js";

const logger = createLogger({ name: "feature-flags" });

const FeatureFlagMatcherSchema = z.object({
  surfaces: z.union([z.array(z.string()), z.literal("*")]),
  intents: z.union([z.array(z.string()), z.literal("*")]),
  traffic_percent: z.number().int().min(0).max(100)
});

const FeatureFlagBucketingSchema = z.object({
  seed_field: z.enum(["session_id", "project", "surface"]).optional()
});

export const FeatureFlagSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  variants: z.object({
    on: z.unknown(),
    off: z.unknown()
  }),
  default: z.enum(["on", "off"]),
  matchers: FeatureFlagMatcherSchema,
  bucketing: FeatureFlagBucketingSchema.optional()
});

export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;
export type FeatureFlagRegistryDegraded = "registry_missing" | "parse_error";

export interface FeatureFlagRegistryLoadResult {
  path: string;
  flags: FeatureFlag[];
  degraded?: FeatureFlagRegistryDegraded;
}

const FeatureFlagRegistrySchema = z.object({
  flags: z.array(FeatureFlagSchema)
});

function expandEnvVars(input: string, env: NodeJS.ProcessEnv): string {
  return input.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name) => {
    const value = env[name];
    return value === undefined ? "" : value;
  });
}

export interface LoadRegistryOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
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

const parseScalar = (value: string): string | number | boolean | null => {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
};

const parseInlineArray = (value: string): unknown[] => {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    return [value]; // will fail schema later
  }
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((item) => parseScalar(item.trim())).filter((item) => item !== "");
};

const parseValue = (value: string): unknown => {
  if (value.startsWith("[") && value.endsWith("]")) {
    return parseInlineArray(value);
  }
  return parseScalar(value);
};

/**
 * Parse a minimal YAML subset tailored to the feature-flag registry format.
 * Supports:
 *   - root key "flags:" with block list or "[]"
 *   - list items at indent 2 ("- ")
 *   - flat properties at indent 4
 *   - one-level nested objects at indent 4 with properties at indent 6
 */
const parseFlagsYaml = (source: string): unknown => {
  const lines: ParsedLine[] = source
    .split(/\r?\n/)
    .map((rawLine, index) => ({
      indent: rawLine.match(/^ */)?.[0].length ?? 0,
      content: rawLine.trim(),
      lineNumber: index + 1
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));

  if (lines.length === 0) {
    throw toParseError("Expected a flags root key.", 1);
  }

  const firstLine = lines[0];
  if (firstLine.indent !== 0 || !firstLine.content.startsWith("flags:")) {
    throw toParseError("Registry must start with 'flags:'.", firstLine.lineNumber);
  }

  const rootValue = firstLine.content.slice("flags:".length).trim();
  if (rootValue === "[]") {
    return { flags: [] };
  }
  if (rootValue.length > 0) {
    throw toParseError("flags must be declared as a block list or [].", firstLine.lineNumber);
  }

  const flags: Array<Record<string, unknown>> = [];
  let currentFlag: Record<string, unknown> | null = null;
  let nestedObject: Record<string, unknown> | null = null;
  let nestedKey: string | null = null;

  for (const line of lines.slice(1)) {
    if (line.indent % 2 !== 0) {
      throw toParseError("Indentation must use multiples of 2 spaces.", line.lineNumber);
    }

    if (line.indent === 2) {
      if (!line.content.startsWith("-")) {
        throw toParseError("Expected a list item under flags.", line.lineNumber);
      }
      currentFlag = {};
      flags.push(currentFlag);
      nestedObject = null;
      nestedKey = null;

      const itemContent = line.content.slice(1).trim();
      if (itemContent.length === 0) {
        continue;
      }
      const [key, value] = splitKeyValue(itemContent, line.lineNumber);
      currentFlag[key] = parseValue(value);
      continue;
    }

    if (line.indent === 4) {
      if (currentFlag === null) {
        throw toParseError("Flag entries must appear under a list item.", line.lineNumber);
      }
      const [key, value] = splitKeyValue(line.content, line.lineNumber);
      if (value === "") {
        // Start a nested object (e.g. variants, matchers, bucketing)
        nestedObject = {};
        nestedKey = key;
        currentFlag[key] = nestedObject;
      } else {
        nestedObject = null;
        nestedKey = null;
        currentFlag[key] = parseValue(value);
      }
      continue;
    }

    if (line.indent === 6) {
      if (nestedObject === null || nestedKey === null) {
        throw toParseError("Nested entries must appear under a nested object key.", line.lineNumber);
      }
      const [key, value] = splitKeyValue(line.content, line.lineNumber);
      nestedObject[key] = parseValue(value);
      continue;
    }

    throw toParseError("Unexpected indentation level.", line.lineNumber);
  }

  return { flags };
};

/**
 * Load feature flag registry from YAML file.
 * Missing file or parse error → empty array + warn log (never throws).
 * Supports ${VAR} env expansion.
 */
export function loadFeatureFlagRegistry(
  path = DEFAULT_FEATURE_FLAG_REGISTRY_PATH,
  options: LoadRegistryOptions = {}
): FeatureFlag[] {
  return inspectFeatureFlagRegistry(path, options).flags;
}

export function inspectFeatureFlagRegistry(
  path = DEFAULT_FEATURE_FLAG_REGISTRY_PATH,
  options: LoadRegistryOptions = {}
): FeatureFlagRegistryLoadResult {
  const resolvedPath = resolve(path);
  const env = options.env ?? process.env;
  const activeLogger = options.logger ?? logger;

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      activeLogger.warn("Feature flag registry is missing.", { path: resolvedPath });
      return {
        path: resolvedPath,
        flags: [],
        degraded: "registry_missing"
      };
    }

    activeLogger.warn("Failed to read feature flag registry.", {
      path: resolvedPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      path: resolvedPath,
      flags: [],
      degraded: "parse_error"
    };
  }

  try {
    const expanded = expandEnvVars(raw, env);
    const parsed = parseFlagsYaml(expanded);
    const validated = FeatureFlagRegistrySchema.safeParse(parsed);

    if (!validated.success) {
      activeLogger.warn("Feature flag registry validation failed.", {
        path: resolvedPath,
        error: z.prettifyError(validated.error)
      });
      return {
        path: resolvedPath,
        flags: [],
        degraded: "parse_error"
      };
    }

    return {
      path: resolvedPath,
      flags: validated.data.flags
    };
  } catch (error) {
    activeLogger.warn("Feature flag registry parse failed.", {
      path: resolvedPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      path: resolvedPath,
      flags: [],
      degraded: "parse_error"
    };
  }
}
