import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, InvalidArgumentError } from "commander";

const DEFAULT_PORT = 3271;
const REQUEST_TIMEOUT_MS = 5_000;
const CONFIG_DIRECTORY = ".vega";
const CURSOR_DIRECTORY = ".cursor";
const CURSOR_RULES_DIRECTORY = "rules";
const CACHE_DB_PATH = "~/.vega/cache.db";
const SNAPSHOT_PATH = "snapshot.md";
const CURSOR_RULES_FILE = "memory.mdc";
const MINIMUM_NODE_MAJOR_VERSION = 18;

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

const getProjectRoot = (): string => fileURLToPath(new URL("../../../", import.meta.url));

const getSetupConfigPath = (): string => join(getVegaDirectory(), "config.json");

const getCursorMcpPath = (): string => join(getCursorDirectory(), "mcp.json");

const getCursorRulesPath = (): string =>
  join(getCursorDirectory(), CURSOR_RULES_DIRECTORY, CURSOR_RULES_FILE);

const getSnapshotOutputPath = (): string => join(getVegaDirectory(), SNAPSHOT_PATH);

const getMcpEntryPath = (): string => fileURLToPath(new URL("../../index.js", import.meta.url));

const getBundledCursorRulesPath = (): string =>
  join(getProjectRoot(), "rules", "cursor-memory.mdc");

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

const installCursorRules = (): string => {
  const cursorRulesPath = getCursorRulesPath();
  mkdirSync(join(getCursorDirectory(), CURSOR_RULES_DIRECTORY), { recursive: true });
  copyFileSync(getBundledCursorRulesPath(), cursorRulesPath);
  return cursorRulesPath;
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

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Configure this machine as a Vega client")
    .requiredOption("--server <ip>", "server IP or hostname")
    .option("--port <port>", "server port", parsePort, DEFAULT_PORT)
    .option("--api-key <key>", "server API key")
    .action(
      async (options: {
        server: string;
        port: number;
        apiKey?: string;
      }) => {
        const nodeVersion = ensureNodeCommand();
        const providedApiKey = options.apiKey?.trim() ?? "";
        const serverUrl = `http://${options.server}:${options.port}`;
        const apiKey = providedApiKey.length > 0 ? providedApiKey : generateApiKey();

        await validateServer(serverUrl, providedApiKey);
        writeSetupConfig(serverUrl, apiKey);
        writeCursorConfig(serverUrl, apiKey);
        const cursorRulesPath = installCursorRules();
        const snapshotPath = syncSnapshot();

        console.log(`Configured Vega client for ${serverUrl}.`);
        console.log(`Node.js check passed: ${nodeVersion}`);
        if (providedApiKey.length === 0) {
          console.log(`Generated API key: ${apiKey}`);
        }
        console.log(`Installed Cursor rules at ${cursorRulesPath}.`);
        if (snapshotPath === null) {
          console.log("Bundled snapshot not found; skipping snapshot sync.");
        } else {
          console.log(`Synced snapshot to ${snapshotPath}.`);
        }
        console.log("Reload Cursor to load the updated MCP configuration.");
      }
    );
}
