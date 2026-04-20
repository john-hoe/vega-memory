import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { createLogger } from "../core/logging/index.js";

const logger = createLogger({ name: "sunset-registry" });
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const DEFAULT_SUNSET_REGISTRY_PATH = resolve(process.cwd(), "docs/sunset-registry.yaml");

const isStrictIsoDate = (value: string): boolean => {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

const SunsetUsageThresholdSchema = z.object({
  metric: z.string().trim().min(1),
  window_days: z.number().int().gt(0),
  max_calls: z.number().int().gte(0)
});

const SunsetTimeBasedSchema = z.object({
  min_days_since_deprecated: z.number().int().gt(0)
});

const SunsetCriteriaSchema = z
  .object({
    usage_threshold: SunsetUsageThresholdSchema.optional(),
    time_based: SunsetTimeBasedSchema.optional()
  })
  .superRefine((value, context) => {
    if (value.usage_threshold !== undefined || value.time_based !== undefined) {
      return;
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one sunset criterion must be defined."
    });
  });

const SunsetNotificationSchema = z.object({
  changelog: z.boolean(),
  log_level: z.enum(["info", "warn", "error"])
});

export const SunsetCandidateSchema = z.object({
  id: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9-]+$/u),
  type: z.literal("api_route"),
  target: z.string().trim().min(1),
  deprecated_since: z.string().trim().regex(DATE_PATTERN).refine(isStrictIsoDate),
  criteria: SunsetCriteriaSchema,
  notification: SunsetNotificationSchema
});

const SunsetRegistrySchema = z.object({
  sunsets: z.array(SunsetCandidateSchema)
});

export type SunsetCandidate = z.infer<typeof SunsetCandidateSchema>;
export type SunsetRegistryDegraded = "registry_missing" | "parse_error";

export interface SunsetRegistryLoadResult {
  path: string;
  candidates: SunsetCandidate[];
  degraded?: SunsetRegistryDegraded;
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

  if (/^-?\d+$/u.test(value)) {
    return Number.parseInt(value, 10);
  }

  return value;
};

const parseRegistryYaml = (source: string): unknown => {
  const lines: ParsedLine[] = source
    .split(/\r?\n/u)
    .map((rawLine, index) => ({
      indent: rawLine.match(/^ */u)?.[0].length ?? 0,
      content: rawLine.trim(),
      lineNumber: index + 1
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));

  if (lines.length === 0) {
    throw toParseError("Expected a sunsets root key.", 1);
  }

  const firstLine = lines[0];

  if (firstLine.indent !== 0 || !firstLine.content.startsWith("sunsets:")) {
    throw toParseError("Registry must start with 'sunsets:'.", firstLine.lineNumber);
  }

  const rootValue = firstLine.content.slice("sunsets:".length).trim();

  if (rootValue === "[]") {
    return { sunsets: [] };
  }

  if (rootValue.length > 0) {
    throw toParseError("sunsets must be declared as a block list or [].", firstLine.lineNumber);
  }

  const sunsets: Array<Record<string, unknown>> = [];
  let currentCandidate: Record<string, unknown> | null = null;
  let currentSection: "criteria" | "notification" | null = null;
  let currentCriteriaKey: "usage_threshold" | "time_based" | null = null;

  for (const line of lines.slice(1)) {
    if (line.indent % 2 !== 0) {
      throw toParseError("Indentation must use multiples of 2 spaces.", line.lineNumber);
    }

    if (line.indent === 2) {
      if (!line.content.startsWith("-")) {
        throw toParseError("Expected a list item under sunsets.", line.lineNumber);
      }

      currentCandidate = {};
      sunsets.push(currentCandidate);
      currentSection = null;
      currentCriteriaKey = null;

      const itemContent = line.content.slice(1).trim();
      if (itemContent.length === 0) {
        continue;
      }

      const [key, value] = splitKeyValue(itemContent, line.lineNumber);
      currentCandidate[key] = parseScalar(value);
      continue;
    }

    if (currentCandidate === null) {
      throw toParseError("Entry content must appear under a list item.", line.lineNumber);
    }

    if (line.indent === 4) {
      if (line.content.endsWith(":")) {
        const key = line.content.slice(0, -1).trim();

        if (key !== "criteria" && key !== "notification") {
          throw toParseError(`Unknown nested section '${key}'.`, line.lineNumber);
        }

        currentSection = key;
        currentCriteriaKey = null;
        currentCandidate[key] = {};
        continue;
      }

      const [key, value] = splitKeyValue(line.content, line.lineNumber);
      currentCandidate[key] = parseScalar(value);
      currentSection = null;
      currentCriteriaKey = null;
      continue;
    }

    if (line.indent === 6) {
      if (currentSection === "notification") {
        const [key, value] = splitKeyValue(line.content, line.lineNumber);
        (currentCandidate.notification as Record<string, unknown>)[key] = parseScalar(value);
        continue;
      }

      if (currentSection === "criteria") {
        if (!line.content.endsWith(":")) {
          throw toParseError("Criteria entries must declare nested objects.", line.lineNumber);
        }

        const key = line.content.slice(0, -1).trim();
        if (key !== "usage_threshold" && key !== "time_based") {
          throw toParseError(`Unknown criteria block '${key}'.`, line.lineNumber);
        }

        currentCriteriaKey = key;
        ((currentCandidate.criteria as Record<string, unknown>)[key] as Record<string, unknown> | undefined) ??=
          {};
        continue;
      }

      throw toParseError("Unexpected indentation level.", line.lineNumber);
    }

    if (line.indent === 8) {
      if (currentSection !== "criteria" || currentCriteriaKey === null) {
        throw toParseError("Nested values are only supported under criteria blocks.", line.lineNumber);
      }

      const [key, value] = splitKeyValue(line.content, line.lineNumber);
      ((currentCandidate.criteria as Record<string, unknown>)[currentCriteriaKey] as Record<string, unknown>)[key] =
        parseScalar(value);
      continue;
    }

    throw toParseError("Unsupported indentation depth.", line.lineNumber);
  }

  return {
    sunsets
  };
};

export function inspectSunsetRegistry(path = DEFAULT_SUNSET_REGISTRY_PATH): SunsetRegistryLoadResult {
  const resolvedPath = resolve(path);

  let source: string;
  try {
    source = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.warn("Sunset registry is missing.", {
        path: resolvedPath
      });
      return {
        path: resolvedPath,
        candidates: [],
        degraded: "registry_missing"
      };
    }

    logger.warn("Failed to read sunset registry.", {
      path: resolvedPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      path: resolvedPath,
      candidates: [],
      degraded: "parse_error"
    };
  }

  try {
    const parsed = parseRegistryYaml(source);
    const validated = SunsetRegistrySchema.safeParse(parsed);

    if (!validated.success) {
      logger.warn("Sunset registry validation failed.", {
        path: resolvedPath,
        error: z.prettifyError(validated.error)
      });
      return {
        path: resolvedPath,
        candidates: [],
        degraded: "parse_error"
      };
    }

    return {
      path: resolvedPath,
      candidates: validated.data.sunsets
    };
  } catch (error) {
    logger.warn("Sunset registry parse failed.", {
      path: resolvedPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      path: resolvedPath,
      candidates: [],
      degraded: "parse_error"
    };
  }
}

export function loadSunsetRegistry(path = DEFAULT_SUNSET_REGISTRY_PATH): SunsetCandidate[] {
  return inspectSunsetRegistry(path).candidates;
}
