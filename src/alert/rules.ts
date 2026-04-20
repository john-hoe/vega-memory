import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { createLogger } from "../core/logging/index.js";

const logger = createLogger({ name: "alert-rules" });

export const DEFAULT_ALERT_RULES_PATH = resolve(process.cwd(), "docs/alerts/alert-rules.yaml");

export const AlertRuleSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9_-]+$/u),
  severity: z.enum(["info", "warn", "critical"]),
  metric: z.string().trim().min(1),
  operator: z.enum([">", ">=", "<", "<="]),
  threshold: z.number(),
  window_ms: z.number().int().gt(0),
  min_duration_ms: z.number().int().gte(0),
  channels: z.array(z.string().trim().min(1)).min(1)
});

const AlertRulesSchema = z.object({
  rules: z.array(AlertRuleSchema)
});

export type AlertRule = z.infer<typeof AlertRuleSchema>;
export type AlertRulesDegraded = "missing" | "parse_error";

export interface AlertRulesLoadResult {
  path: string;
  rules: AlertRule[];
  degraded?: AlertRulesDegraded;
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

const parseInlineArray = (value: string, lineNumber: number): string[] => {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw toParseError("Expected an inline array like [a, b].", lineNumber);
  }

  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }

  return inner
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => String(parseScalar(item)));
};

const parseRulesYaml = (source: string): unknown => {
  const lines: ParsedLine[] = source
    .split(/\r?\n/u)
    .map((rawLine, index) => ({
      indent: rawLine.match(/^ */u)?.[0].length ?? 0,
      content: rawLine.trim(),
      lineNumber: index + 1
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));

  if (lines.length === 0) {
    throw toParseError("Expected a rules root key.", 1);
  }

  const firstLine = lines[0];
  if (firstLine.indent !== 0 || !firstLine.content.startsWith("rules:")) {
    throw toParseError("Registry must start with 'rules:'.", firstLine.lineNumber);
  }

  const rootValue = firstLine.content.slice("rules:".length).trim();
  if (rootValue === "[]") {
    return { rules: [] };
  }

  if (rootValue.length > 0) {
    throw toParseError("rules must be declared as a block list or [].", firstLine.lineNumber);
  }

  const rules: Array<Record<string, unknown>> = [];
  let currentRule: Record<string, unknown> | null = null;

  for (const line of lines.slice(1)) {
    if (line.indent % 2 !== 0) {
      throw toParseError("Indentation must use multiples of 2 spaces.", line.lineNumber);
    }

    if (line.indent === 2) {
      if (!line.content.startsWith("-")) {
        throw toParseError("Expected a list item under rules.", line.lineNumber);
      }

      currentRule = {};
      rules.push(currentRule);

      const itemContent = line.content.slice(1).trim();
      if (itemContent.length === 0) {
        continue;
      }

      const [key, value] = splitKeyValue(itemContent, line.lineNumber);
      currentRule[key] = key === "channels" ? parseInlineArray(value, line.lineNumber) : parseScalar(value);
      continue;
    }

    if (line.indent !== 4 || currentRule === null) {
      throw toParseError("Rule entries must appear under a list item.", line.lineNumber);
    }

    const [key, value] = splitKeyValue(line.content, line.lineNumber);
    currentRule[key] = key === "channels" ? parseInlineArray(value, line.lineNumber) : parseScalar(value);
  }

  return { rules };
};

const toThresholdOverrideKey = (ruleId: string): string =>
  `VEGA_ALERT_RULE_${ruleId.replace(/[^a-z0-9]+/giu, "_").toUpperCase()}_THRESHOLD`;

const applyThresholdOverrides = (
  rules: AlertRule[],
  thresholdOverrides?: Record<string, string | undefined>
): AlertRule[] =>
  rules.map((rule) => {
    const rawOverride = thresholdOverrides?.[toThresholdOverrideKey(rule.id)];
    const parsedOverride =
      rawOverride === undefined || rawOverride.trim().length === 0 ? Number.NaN : Number(rawOverride);

    if (!Number.isFinite(parsedOverride)) {
      return rule;
    }

    return {
      ...rule,
      threshold: parsedOverride
    };
  });

export function inspectAlertRules(
  path = DEFAULT_ALERT_RULES_PATH,
  thresholdOverrides?: Record<string, string | undefined>
): AlertRulesLoadResult {
  const resolvedPath = resolve(path);

  let source: string;
  try {
    source = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.warn("Alert rules file is missing.", {
        path: resolvedPath
      });
      return {
        path: resolvedPath,
        rules: [],
        degraded: "missing"
      };
    }

    logger.warn("Failed to read alert rules.", {
      path: resolvedPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      path: resolvedPath,
      rules: [],
      degraded: "parse_error"
    };
  }

  try {
    const parsed = parseRulesYaml(source);
    const validated = AlertRulesSchema.safeParse(parsed);

    if (!validated.success) {
      logger.warn("Alert rules validation failed.", {
        path: resolvedPath,
        error: z.prettifyError(validated.error)
      });
      return {
        path: resolvedPath,
        rules: [],
        degraded: "parse_error"
      };
    }

    return {
      path: resolvedPath,
      rules: applyThresholdOverrides(validated.data.rules, thresholdOverrides)
    };
  } catch (error) {
    logger.warn("Alert rules parse failed.", {
      path: resolvedPath,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      path: resolvedPath,
      rules: [],
      degraded: "parse_error"
    };
  }
}

export function loadAlertRules(
  path = DEFAULT_ALERT_RULES_PATH,
  thresholdOverrides?: Record<string, string | undefined>
): AlertRule[] {
  return inspectAlertRules(path, thresholdOverrides).rules;
}
