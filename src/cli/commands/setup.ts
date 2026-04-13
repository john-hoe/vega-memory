import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, InvalidArgumentError } from "commander";

const DEFAULT_PORT = 3271;
const REQUEST_TIMEOUT_MS = 5_000;
const CONFIG_DIRECTORY = ".vega";
const CURSOR_DIRECTORY = ".cursor";
const CURSOR_RULES_DIRECTORY = "rules";
const CURSOR_RULES_FILE = "memory.mdc";
const CODEX_DIRECTORY = ".codex";
const CLAUDE_DIRECTORY = ".claude";
const CACHE_DB_PATH = "~/.vega/cache.db";
const SNAPSHOT_PATH = "snapshot.md";
const MINIMUM_NODE_MAJOR_VERSION = 18;
const MANAGED_SECTION_START = "<!-- Vega Memory System: START -->";
const MANAGED_SECTION_END = "<!-- Vega Memory System: END -->";
const CODEX_RULE_SIGNATURE = "Rules for Codex CLI:";
const CLAUDE_RULE_SIGNATURE = "# Vega Memory System — Claude Code Rules";

type SetupTarget = "cursor" | "codex" | "claude";

interface SetupSelection {
  cursor: boolean;
  codex: boolean;
  claude: boolean;
}

interface TargetStatus {
  target: SetupTarget;
  state: "configured" | "partial" | "missing";
  details: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsePort = (value: string): number => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new InvalidArgumentError("port must be an integer between 1 and 65535");
  }

  return parsed;
};

const getVegaDirectory = (): string => join(homedir(), CONFIG_DIRECTORY);

const getCursorDirectory = (): string => join(homedir(), CURSOR_DIRECTORY);

const getCodexDirectory = (): string => join(homedir(), CODEX_DIRECTORY);

const getClaudeDirectory = (): string => join(homedir(), CLAUDE_DIRECTORY);

const getProjectRoot = (): string => fileURLToPath(new URL("../../../", import.meta.url));

const getSetupConfigPath = (): string => join(getVegaDirectory(), "config.json");

const getCursorMcpPath = (): string => join(getCursorDirectory(), "mcp.json");

const getCursorRulesPath = (): string =>
  join(getCursorDirectory(), CURSOR_RULES_DIRECTORY, CURSOR_RULES_FILE);

const getCodexRulesPath = (): string => join(getCodexDirectory(), "AGENTS.md");

const getClaudeRulesPath = (): string => join(getClaudeDirectory(), "CLAUDE.md");

const getSnapshotOutputPath = (): string => join(getVegaDirectory(), SNAPSHOT_PATH);

const getMcpEntryPath = (): string => fileURLToPath(new URL("../../index.js", import.meta.url));

const getBundledCursorRulesPath = (): string =>
  join(getProjectRoot(), "rules", "cursor-memory.mdc");

const getBundledCodexRulesPath = (): string =>
  join(getProjectRoot(), "rules", "CODEX.md");

const getBundledClaudeRulesPath = (): string =>
  join(getProjectRoot(), "rules", "CLAUDE.md");

const parseNodeMajorVersion = (value: string): number => {
  const normalized = value.trim().replace(/^v/i, "");
  const [majorComponent] = normalized.split(".", 1);
  const majorVersion = Number.parseInt(majorComponent ?? "", 10);

  if (!Number.isInteger(majorVersion)) {
    throw new Error(`Unable to parse Node.js version: ${value}`);
  }

  return majorVersion;
};

const ensureNodeCommand = (): string => {
  const runtimeVersion = process.versions.node;
  const runtimeMajorVersion = parseNodeMajorVersion(runtimeVersion);

  if (runtimeMajorVersion < MINIMUM_NODE_MAJOR_VERSION) {
    throw new Error(
      `Vega setup requires Node.js ${MINIMUM_NODE_MAJOR_VERSION}+ (current runtime: ${runtimeVersion})`
    );
  }

  const result = spawnSync("node", ["--version"], {
    encoding: "utf8"
  });

  if (result.error) {
    throw new Error("Node.js command `node` is required on PATH for Cursor MCP.");
  }

  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "unknown error";
    throw new Error(`Node.js check failed: ${detail}`);
  }

  const nodeVersion = result.stdout.trim();
  const nodeMajorVersion = parseNodeMajorVersion(nodeVersion);

  if (nodeMajorVersion < MINIMUM_NODE_MAJOR_VERSION) {
    throw new Error(
      `Node.js command \`node\` must be version ${MINIMUM_NODE_MAJOR_VERSION}+ (found ${nodeVersion})`
    );
  }

  return nodeVersion;
};

const generateApiKey = (): string => `vega_${randomBytes(24).toString("hex")}`;

const writeJsonFile = (filePath: string, value: unknown): void => {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const readJsonFile = (filePath: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
};

const validateServer = async (serverUrl: string, apiKey: string): Promise<void> => {
  const headers = new Headers();

  if (apiKey.length > 0) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }

  try {
    const response = await fetch(`${serverUrl}/api/health`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error("unreachable");
    }
  } catch {
    throw new Error(`Cannot reach Vega server at ${serverUrl}`);
  }
};

const getBundledSnapshotSourcePath = (): string | null => {
  const projectRoot = getProjectRoot();
  const preferredPath = join(projectRoot, "data", "vega-memory-snapshot.md");
  if (existsSync(preferredPath)) {
    return preferredPath;
  }

  const snapshotsDirectory = join(projectRoot, "data", "snapshots");
  if (!existsSync(snapshotsDirectory)) {
    return null;
  }

  const latestSnapshot = readdirSync(snapshotsDirectory)
    .filter((entry) => /^snapshot-\d{4}-\d{2}-\d{2}\.md$/u.test(entry))
    .sort((left, right) => left.localeCompare(right))
    .at(-1);

  return latestSnapshot ? join(snapshotsDirectory, latestSnapshot) : null;
};

const syncSnapshot = (): string | null => {
  const bundledSnapshotPath = getBundledSnapshotSourcePath();
  if (bundledSnapshotPath === null) {
    return null;
  }

  const outputPath = getSnapshotOutputPath();
  mkdirSync(getVegaDirectory(), { recursive: true });
  copyFileSync(bundledSnapshotPath, outputPath);
  return outputPath;
};

const writeSetupConfig = (serverUrl: string, apiKey: string): void => {
  const configDirectory = getVegaDirectory();
  mkdirSync(configDirectory, { recursive: true });

  writeJsonFile(getSetupConfigPath(), {
    mode: "client",
    server: serverUrl,
    api_key: apiKey,
    cache_db: CACHE_DB_PATH,
    sync_interval_minutes: 5
  });
};

const writeCursorConfig = (serverUrl: string, apiKey: string): void => {
  const cursorDirectory = getCursorDirectory();
  mkdirSync(cursorDirectory, { recursive: true });

  const existing = readJsonFile(getCursorMcpPath());
  const existingServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};

  writeJsonFile(getCursorMcpPath(), {
    ...existing,
    mcpServers: {
      ...existingServers,
      vega: {
        command: "node",
        args: [getMcpEntryPath()],
        env: {
          VEGA_MODE: "client",
          VEGA_SERVER_URL: serverUrl,
          VEGA_API_KEY: apiKey,
          VEGA_CACHE_DB: CACHE_DB_PATH
        }
      }
    }
  });
};

const installCursorRules = (): string => {
  const cursorRulesPath = getCursorRulesPath();
  mkdirSync(join(getCursorDirectory(), CURSOR_RULES_DIRECTORY), { recursive: true });
  copyFileSync(getBundledCursorRulesPath(), cursorRulesPath);
  return cursorRulesPath;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const managedSectionPattern = new RegExp(
  `${escapeRegExp(MANAGED_SECTION_START)}[\\s\\S]*?${escapeRegExp(MANAGED_SECTION_END)}\\n?`,
  "u"
);

const buildManagedSection = (content: string): string =>
  `${MANAGED_SECTION_START}\n${content.trimEnd()}\n${MANAGED_SECTION_END}\n`;

const upsertManagedSection = (filePath: string, content: string): string => {
  mkdirSync(dirname(filePath), { recursive: true });

  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const managedSection = buildManagedSection(content);
  let next = "";

  if (managedSectionPattern.test(existing)) {
    next = existing.replace(managedSectionPattern, managedSection);
  } else if (existing.trim().length === 0) {
    next = managedSection;
  } else {
    next = `${existing.trimEnd()}\n\n${managedSection}`;
  }

  writeFileSync(filePath, next, "utf8");
  return filePath;
};

const installCodexRules = (): string =>
  upsertManagedSection(getCodexRulesPath(), readFileSync(getBundledCodexRulesPath(), "utf8"));

const installClaudeRules = (): string =>
  upsertManagedSection(getClaudeRulesPath(), readFileSync(getBundledClaudeRulesPath(), "utf8"));

const resolveSelection = (options: {
  show?: boolean;
  cursor?: boolean;
  codex?: boolean;
  claude?: boolean;
  server?: string;
}): SetupSelection => {
  const explicitSelection = options.cursor || options.codex || options.claude;

  if (explicitSelection) {
    return {
      cursor: Boolean(options.cursor),
      codex: Boolean(options.codex),
      claude: Boolean(options.claude)
    };
  }

  if (options.show) {
    return {
      cursor: true,
      codex: true,
      claude: true
    };
  }

  if (typeof options.server === "string" && options.server.trim().length > 0) {
    return {
      cursor: true,
      codex: false,
      claude: false
    };
  }

  throw new Error("Select at least one setup target with --cursor, --codex, or --claude, or use --show.");
};

const detectRuleStatus = (filePath: string, signature: string): TargetStatus["state"] => {
  if (!existsSync(filePath)) {
    return "missing";
  }

  const content = readFileSync(filePath, "utf8");
  const hasManagedMarkers =
    content.includes(MANAGED_SECTION_START) && content.includes(MANAGED_SECTION_END);
  const hasSignature = content.includes(signature);

  if (hasManagedMarkers && hasSignature) {
    return "configured";
  }

  if (hasSignature) {
    return "partial";
  }

  return "missing";
};

const inspectCursorStatus = (): TargetStatus => {
  const config = readJsonFile(getSetupConfigPath());
  const cursorMcp = readJsonFile(getCursorMcpPath());
  const mcpServers = isRecord(cursorMcp.mcpServers) ? cursorMcp.mcpServers : {};
  const vegaEntry = isRecord(mcpServers.vega) ? mcpServers.vega : null;
  const server = typeof config.server === "string" ? config.server : null;
  const hasRules = existsSync(getCursorRulesPath());
  const hasSnapshot = existsSync(getSnapshotOutputPath());
  const details: string[] = [];

  if (server !== null) {
    details.push(`server ${server}`);
  } else {
    details.push("missing ~/.vega/config.json server");
  }

  if (vegaEntry !== null) {
    details.push(`MCP entry in ${getCursorMcpPath()}`);
  } else {
    details.push(`missing Vega MCP entry in ${getCursorMcpPath()}`);
  }

  if (hasRules) {
    details.push(`rules ${getCursorRulesPath()}`);
  } else {
    details.push(`missing rules ${getCursorRulesPath()}`);
  }

  details.push(
    hasSnapshot ? `snapshot ${getSnapshotOutputPath()}` : "snapshot not synced"
  );

  if (server !== null && vegaEntry !== null && hasRules) {
    return {
      target: "cursor",
      state: "configured",
      details
    };
  }

  if (server !== null || vegaEntry !== null || hasRules || hasSnapshot) {
    return {
      target: "cursor",
      state: "partial",
      details
    };
  }

  return {
    target: "cursor",
    state: "missing",
    details
  };
};

const inspectCodexStatus = (): TargetStatus => ({
  target: "codex",
  state: detectRuleStatus(getCodexRulesPath(), CODEX_RULE_SIGNATURE),
  details: [getCodexRulesPath()]
});

const inspectClaudeStatus = (): TargetStatus => ({
  target: "claude",
  state: detectRuleStatus(getClaudeRulesPath(), CLAUDE_RULE_SIGNATURE),
  details: [getClaudeRulesPath()]
});

const inspectStatuses = (selection: SetupSelection): TargetStatus[] => {
  const statuses: TargetStatus[] = [];

  if (selection.cursor) {
    statuses.push(inspectCursorStatus());
  }

  if (selection.codex) {
    statuses.push(inspectCodexStatus());
  }

  if (selection.claude) {
    statuses.push(inspectClaudeStatus());
  }

  return statuses;
};

const formatState = (state: TargetStatus["state"]): string => {
  if (state === "configured") {
    return "configured";
  }

  if (state === "partial") {
    return "partial";
  }

  return "missing";
};

const printStatuses = (statuses: TargetStatus[]): void => {
  for (const status of statuses) {
    console.log(`${status.target}: ${formatState(status.state)}`);
    for (const detail of status.details) {
      console.log(`  - ${detail}`);
    }
  }
};

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Configure Vega integrations for Cursor, Codex, and Claude Code")
    .option("--server <ip>", "server IP or hostname")
    .option("--port <port>", "server port", parsePort, DEFAULT_PORT)
    .option("--api-key <key>", "server API key")
    .option("--cursor", "configure Cursor MCP and rules")
    .option("--codex", "install Codex rules")
    .option("--claude", "install Claude Code rules")
    .option("--show", "show current setup status")
    .action(
      async (options: {
        server?: string;
        port: number;
        apiKey?: string;
        cursor?: boolean;
        codex?: boolean;
        claude?: boolean;
        show?: boolean;
      }) => {
        const selection = resolveSelection(options);

        if (options.show) {
          printStatuses(inspectStatuses(selection));
          return;
        }

        if (selection.cursor && (options.server?.trim().length ?? 0) === 0) {
          throw new Error("--server is required when configuring Cursor.");
        }

        const outputLines: string[] = [];

        if (selection.cursor) {
          const nodeVersion = ensureNodeCommand();
          const providedApiKey = options.apiKey?.trim() ?? "";
          const serverUrl = `http://${options.server}:${options.port}`;
          const apiKey = providedApiKey.length > 0 ? providedApiKey : generateApiKey();

          await validateServer(serverUrl, providedApiKey);
          writeSetupConfig(serverUrl, apiKey);
          writeCursorConfig(serverUrl, apiKey);
          const cursorRulesPath = installCursorRules();
          const snapshotPath = syncSnapshot();

          outputLines.push(`Configured Cursor client for ${serverUrl}.`);
          outputLines.push(`Node.js check passed: ${nodeVersion}`);
          if (providedApiKey.length === 0) {
            outputLines.push(`Generated API key: ${apiKey}`);
          }
          outputLines.push(`Installed Cursor rules at ${cursorRulesPath}.`);
          if (snapshotPath === null) {
            outputLines.push("Bundled snapshot not found; skipping snapshot sync.");
          } else {
            outputLines.push(`Synced snapshot to ${snapshotPath}.`);
          }
          outputLines.push("Reload Cursor to load the updated MCP configuration.");
        }

        if (selection.codex) {
          const codexRulesPath = installCodexRules();
          outputLines.push(`Installed Codex rules at ${codexRulesPath}.`);
          outputLines.push("Reload Codex or start a new session to pick up the managed AGENTS section.");
        }

        if (selection.claude) {
          const claudeRulesPath = installClaudeRules();
          outputLines.push(`Installed Claude Code rules at ${claudeRulesPath}.`);
          outputLines.push("Reload Claude Code or start a new session to pick up the managed rules section.");
        }

        for (const line of outputLines) {
          console.log(line);
        }
      }
    );
}
