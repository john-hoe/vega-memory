import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KNOWN_INSECURE_API_KEYS,
  requireDatabaseEncryptionKey,
  type VegaConfig
} from "../config.js";
import { isOllamaAvailable } from "../embedding/ollama.js";
import { createAdapter } from "../db/adapter-factory.js";
import type {
  IntegrationSurface,
  IntegrationSurfaceStatus,
  ManagedSetupStatus,
  ObservedActivityStatus,
  ObservedActivityWindowStatus,
  RuntimeHealthStatus
} from "./types.js";
import { Repository } from "../db/repository.js";
import { resolveConfiguredEncryptionKey } from "../security/keychain.js";

const MINIMUM_NODE_MAJOR_VERSION = 18;
const CONFIG_DIRECTORY = ".vega";
const CURSOR_DIRECTORY = ".cursor";
const CURSOR_RULES_DIRECTORY = "rules";
const CURSOR_RULES_FILE = "memory.mdc";
const CODEX_DIRECTORY = ".codex";
const CLAUDE_DIRECTORY = ".claude";
const MANAGED_SECTION_START = "<!-- Vega Memory System: START -->";
const MANAGED_SECTION_END = "<!-- Vega Memory System: END -->";
const CODEX_RULE_SIGNATURE = "Rules for Codex CLI:";
const CLAUDE_RULE_SIGNATURE = "# Vega Memory System — Claude Code Rules";
const SUPPORTED_SURFACES: IntegrationSurface[] = [
  "cursor",
  "codex",
  "claude",
  "api",
  "cli"
];

interface ManagedSetupEvaluation {
  status: ManagedSetupStatus;
  details: string[];
  cursorServerUrl?: string;
  cursorApiKey?: string;
}

interface RuntimeHealthEvaluation {
  status: RuntimeHealthStatus;
  details: string[];
}

interface ActivityRecord {
  surface: IntegrationSurface;
  integration?: string;
  timestamp: string;
}

const getProjectRoot = (): string => fileURLToPath(new URL("../../", import.meta.url));
const getVegaDirectory = (): string => join(homedir(), CONFIG_DIRECTORY);
const getCursorDirectory = (): string => join(homedir(), CURSOR_DIRECTORY);
const getCodexDirectory = (): string => join(homedir(), CODEX_DIRECTORY);
const getClaudeDirectory = (): string => join(homedir(), CLAUDE_DIRECTORY);

const isHomeOverrideActive = (): boolean => {
  const homeOverride = process.env.HOME;

  if (!homeOverride) {
    return false;
  }

  return resolve(homeOverride) !== resolve(userInfo().homedir);
};

const parseNodeMajorVersion = (value: string): number => {
  const normalized = value.trim().replace(/^v/i, "");
  const [majorComponent] = normalized.split(".", 1);
  const majorVersion = Number.parseInt(majorComponent ?? "", 10);

  return Number.isInteger(majorVersion) ? majorVersion : 0;
};

const checkNodeCommand = (): {
  available: boolean;
  detail: string;
} => {
  const result = spawnSync("node", ["--version"], {
    encoding: "utf8"
  });

  if (result.error) {
    return {
      available: false,
      detail: "Node.js command `node` is not available on PATH."
    };
  }

  const version = result.stdout.trim();
  const majorVersion = parseNodeMajorVersion(version);

  if (majorVersion < MINIMUM_NODE_MAJOR_VERSION) {
    return {
      available: false,
      detail: `Node.js must be ${MINIMUM_NODE_MAJOR_VERSION}+ (found ${version || "unknown"}).`
    };
  }

  return {
    available: true,
    detail: `Node.js available (${version}).`
  };
};

const readJsonFile = (filePath: string): Record<string, unknown> => {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const detectRuleStatus = (filePath: string, signature: string): ManagedSetupEvaluation => {
  if (!existsSync(filePath)) {
    return {
      status: "missing",
      details: [filePath]
    };
  }

  const content = readFileSync(filePath, "utf8");
  const hasManagedMarkers =
    content.includes(MANAGED_SECTION_START) && content.includes(MANAGED_SECTION_END);
  const hasSignature = content.includes(signature);

  return {
    status:
      hasManagedMarkers && hasSignature
        ? "configured"
        : hasManagedMarkers || hasSignature
          ? "partial"
          : "missing",
    details: [filePath]
  };
};

const inspectCursorManagedSetup = (): ManagedSetupEvaluation => {
  const setupConfigPath = join(getVegaDirectory(), "config.json");
  const cursorMcpPath = join(getCursorDirectory(), "mcp.json");
  const cursorRulesPath = join(getCursorDirectory(), CURSOR_RULES_DIRECTORY, CURSOR_RULES_FILE);
  const snapshotPath = join(getVegaDirectory(), "snapshot.md");

  const setupConfig = readJsonFile(setupConfigPath);
  const cursorConfig = readJsonFile(cursorMcpPath);
  const server = typeof setupConfig.server === "string" ? setupConfig.server : undefined;
  const apiKey = typeof setupConfig.api_key === "string" ? setupConfig.api_key : undefined;
  const mcpServers =
    typeof cursorConfig.mcpServers === "object" &&
    cursorConfig.mcpServers !== null &&
    !Array.isArray(cursorConfig.mcpServers)
      ? (cursorConfig.mcpServers as Record<string, unknown>)
      : {};
  const hasMcpEntry =
    typeof mcpServers.vega === "object" && mcpServers.vega !== null && !Array.isArray(mcpServers.vega);
  const hasRules = existsSync(cursorRulesPath);
  const hasSnapshot = existsSync(snapshotPath);
  const details = [
    server ? `server ${server}` : `missing ${setupConfigPath}`,
    hasMcpEntry ? `MCP entry in ${cursorMcpPath}` : `missing MCP entry in ${cursorMcpPath}`,
    hasRules ? `rules ${cursorRulesPath}` : `missing rules ${cursorRulesPath}`,
    hasSnapshot ? `snapshot ${snapshotPath}` : "snapshot not synced"
  ];
  const completeCount = [Boolean(server), hasMcpEntry, hasRules, hasSnapshot].filter(Boolean).length;

  return {
    status:
      completeCount === 4
        ? "configured"
        : completeCount > 0
          ? "partial"
          : "missing",
    details,
    cursorServerUrl: server,
    cursorApiKey: apiKey
  };
};

const inspectCliManagedSetup = (): ManagedSetupEvaluation => {
  const cliEntryPath = join(getProjectRoot(), "dist", "cli", "index.js");
  const node = checkNodeCommand();
  const cliEntryExists = existsSync(cliEntryPath);

  return {
    status:
      cliEntryExists && node.available
        ? "configured"
        : cliEntryExists || node.available
          ? "partial"
          : "missing",
    details: [
      cliEntryExists ? `CLI entry ${cliEntryPath}` : `missing CLI entry ${cliEntryPath}`,
      node.detail
    ]
  };
};

const inspectApiManagedSetup = (config: VegaConfig): ManagedSetupEvaluation => {
  if (config.mode === "server" && config.apiKey) {
    return {
      status: "configured",
      details: [`server mode on port ${config.apiPort}`, "API key configured"]
    };
  }

  if (config.mode === "server" || config.apiKey) {
    return {
      status: "partial",
      details: [
        `mode=${config.mode}`,
        config.apiKey ? "API key configured" : "API key missing"
      ]
    };
  }

  return {
    status: "missing",
    details: [`mode=${config.mode}`, "API surface not enabled"]
  };
};

const inspectManagedSetup = (surface: IntegrationSurface, config: VegaConfig): ManagedSetupEvaluation => {
  switch (surface) {
    case "cursor":
      return inspectCursorManagedSetup();
    case "codex":
      return detectRuleStatus(join(getCodexDirectory(), "AGENTS.md"), CODEX_RULE_SIGNATURE);
    case "claude":
      return detectRuleStatus(join(getClaudeDirectory(), "CLAUDE.md"), CLAUDE_RULE_SIGNATURE);
    case "api":
      return inspectApiManagedSetup(config);
    case "cli":
      return inspectCliManagedSetup();
  }
};

const toWindowStart = (days: number): string => {
  const current = new Date();
  current.setUTCHours(0, 0, 0, 0);
  current.setUTCDate(current.getUTCDate() - days + 1);
  return current.toISOString();
};

const parseSurfaceRecord = (value: string | null): {
  surface?: IntegrationSurface;
  integration?: string;
} => {
  if (value === null) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const surface =
      typeof parsed.surface === "string" && SUPPORTED_SURFACES.includes(parsed.surface as IntegrationSurface)
        ? (parsed.surface as IntegrationSurface)
        : undefined;
    const integration = typeof parsed.integration === "string" ? parsed.integration : undefined;

    return { surface, integration };
  } catch {
    return {};
  }
};

const collectActivityRecords = (repository?: Repository): ActivityRecord[] => {
  if (!repository) {
    return [];
  }

  const memoryRows = repository.db
    .prepare<[], { source_context: string | null; updated_at: string }>(
      `SELECT source_context, updated_at
       FROM memories
       WHERE source_context IS NOT NULL`
    )
    .all();
  const performanceRows = repository.db
    .prepare<[], { detail: string | null; timestamp: string }>(
      `SELECT detail, timestamp
       FROM performance_log
       WHERE detail IS NOT NULL`
    )
    .all();
  const records: ActivityRecord[] = [];

  for (const row of memoryRows) {
    const parsed = parseSurfaceRecord(row.source_context);
    if (parsed.surface) {
      records.push({
        surface: parsed.surface,
        integration: parsed.integration,
        timestamp: row.updated_at
      });
    }
  }

  for (const row of performanceRows) {
    const parsed = parseSurfaceRecord(row.detail);
    if (parsed.surface) {
      records.push({
        surface: parsed.surface,
        integration: parsed.integration,
        timestamp: row.timestamp
      });
    }
  }

  return records;
};

const summarizeObservedActivity = (
  surface: IntegrationSurface,
  records: ActivityRecord[],
  days: number
): ObservedActivityWindowStatus => {
  const surfaceRecords = records.filter((record) => record.surface === surface);
  const windowStart = toWindowStart(days);
  const inWindow = surfaceRecords.filter((record) => record.timestamp >= windowStart);

  if (surfaceRecords.length === 0) {
    return {
      window_days: days,
      status: "unknown",
      observed_count: 0,
      last_observed_at: null
    };
  }

  return {
    window_days: days,
    status: inWindow.length > 0 ? "active" : "inactive",
    observed_count: inWindow.length,
    last_observed_at: surfaceRecords
      .map((record) => record.timestamp)
      .sort((left, right) => right.localeCompare(left))[0] ?? null
  };
};

const buildObservedActivityDetails = (
  surface: IntegrationSurface,
  window7d: ObservedActivityWindowStatus,
  window30d: ObservedActivityWindowStatus
): string[] => {
  if (window30d.status === "unknown") {
    return [
      `${surface} has no attributed activity yet; returning unknown until tagged events are observed.`
    ];
  }

  return [
    `7d: ${window7d.status} (${window7d.observed_count} events)`,
    `30d: ${window30d.status} (${window30d.observed_count} events)`,
    window30d.last_observed_at ? `last observed at ${window30d.last_observed_at}` : "no observed timestamp"
  ];
};

const evaluateRuntimeHealth = async (
  surface: IntegrationSurface,
  config: VegaConfig,
  managed: ManagedSetupEvaluation
): Promise<RuntimeHealthEvaluation> => {
  const node = checkNodeCommand();

  switch (surface) {
    case "cursor": {
      if (!node.available) {
        return {
          status: "fail",
          details: [node.detail]
        };
      }

      if (managed.cursorServerUrl) {
        try {
          const headers = new Headers();
          if (managed.cursorApiKey) {
            headers.set("authorization", `Bearer ${managed.cursorApiKey}`);
          }

          const response = await fetch(`${managed.cursorServerUrl}/api/health`, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(3_000)
          });

          if (response.ok) {
            return {
              status: "ok",
              details: [`Cursor server reachable at ${managed.cursorServerUrl}`]
            };
          }
        } catch {}

        return {
          status: "fail",
          details: [`Cursor server is unreachable at ${managed.cursorServerUrl}`]
        };
      }

      return {
        status: "warn",
        details: ["Cursor managed setup is not complete, so runtime health is only partially observable."]
      };
    }
    case "codex":
    case "claude":
    case "cli":
      if (!node.available) {
        return {
          status: "fail",
          details: [node.detail]
        };
      }

      return {
        status: "ok",
        details: [node.detail]
      };
    case "api":
      if (config.mode !== "server") {
        return {
          status: "fail",
          details: ["HTTP / API surface cannot be healthy while VEGA_MODE=client."]
        };
      }

      if (!config.apiKey) {
        return {
          status: "warn",
          details: ["HTTP / API is running without VEGA_API_KEY, so authenticated remote access is incomplete."]
        };
      }

      if (KNOWN_INSECURE_API_KEYS.has(config.apiKey)) {
        return {
          status: "warn",
          details: ["HTTP / API is using a known insecure default API key."]
        };
      }

      return {
        status: "ok",
        details: [`HTTP / API is enabled on port ${config.apiPort}.`]
      };
  }
};

const buildNextAction = (status: IntegrationSurfaceStatus): string | undefined => {
  if (status.managed_setup_status === "missing") {
    switch (status.surface) {
      case "cursor":
        return "Run `vega setup --server <host> --cursor` or wire the local MCP entry manually.";
      case "codex":
        return "Run `vega setup --codex` to install the managed Codex rules section.";
      case "claude":
        return "Run `vega setup --claude` to install the managed Claude rules section.";
      case "api":
        return "Enable server mode with VEGA_API_KEY so the HTTP / API surface becomes configured.";
      case "cli":
        return "Build the CLI and ensure `node` plus the Vega CLI entry are available.";
    }
  }

  if (status.runtime_health_status === "fail" || status.runtime_health_status === "warn") {
    return status.runtime_health_details[0];
  }

  if (status.observed_activity_status === "unknown") {
    return "Generate new tagged activity on this surface; legacy or untagged data intentionally stays unknown.";
  }

  if (status.observed_activity_status === "inactive") {
    return `Use ${status.surface} in the next 7 days to refresh its observed activity signal.`;
  }

  return undefined;
};

export const buildIntegrationSurfaceStatuses = async (options: {
  config: VegaConfig;
  repository?: Repository | null;
}): Promise<IntegrationSurfaceStatus[]> => {
  const records =
    options.repository === undefined && isHomeOverrideActive()
      ? []
      : collectActivityRecords(options.repository ?? undefined);

  return Promise.all(
    SUPPORTED_SURFACES.map(async (surface) => {
      const managed = inspectManagedSetup(surface, options.config);
      const window7d = summarizeObservedActivity(surface, records, 7);
      const window30d = summarizeObservedActivity(surface, records, 30);
      const runtime = await evaluateRuntimeHealth(surface, options.config, managed);
      const status: IntegrationSurfaceStatus = {
        surface,
        managed_setup_status: managed.status,
        observed_activity_status: window7d.status,
        observed_activity_windows: {
          window_7d: window7d,
          window_30d: window30d
        },
        runtime_health_status: runtime.status,
        managed_setup_details: managed.details,
        observed_activity_details: buildObservedActivityDetails(surface, window7d, window30d),
        runtime_health_details: runtime.details
      };

      return {
        ...status,
        ...(buildNextAction(status) ? { next_action: buildNextAction(status) } : {})
      };
    })
  );
};

export const summarizeIntegrationSurfaces = (
  surfaces: IntegrationSurfaceStatus[]
): {
  configured_count: number;
  active_7d_count: number;
  unknown_7d_count: number;
} => ({
  configured_count: surfaces.filter((surface) => surface.managed_setup_status === "configured").length,
  active_7d_count: surfaces.filter((surface) => surface.observed_activity_windows.window_7d.status === "active").length,
  unknown_7d_count: surfaces.filter((surface) => surface.observed_activity_windows.window_7d.status === "unknown").length
});

export const openRepositoryForSurfaceStatus = async (
  config: VegaConfig
): Promise<Repository | null> => {
  try {
    const encryptionKey = requireDatabaseEncryptionKey(
      config,
      config.dbEncryption ? await resolveConfiguredEncryptionKey(config) : undefined
    );
    return new Repository(createAdapter({ ...config, encryptionKey }));
  } catch {
    return null;
  }
};
