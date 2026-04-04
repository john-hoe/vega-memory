import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, InvalidArgumentError } from "commander";

const DEFAULT_PORT = 3271;
const REQUEST_TIMEOUT_MS = 5_000;
const CONFIG_DIRECTORY = ".vega";
const CURSOR_DIRECTORY = ".cursor";
const CACHE_DB_PATH = "~/.vega/cache.db";

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

const getSetupConfigPath = (): string => join(getVegaDirectory(), "config.json");

const getCursorMcpPath = (): string => join(getCursorDirectory(), "mcp.json");

const getMcpEntryPath = (): string => fileURLToPath(new URL("../../index.js", import.meta.url));

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
        const apiKey = options.apiKey ?? "";
        const serverUrl = `http://${options.server}:${options.port}`;

        await validateServer(serverUrl, apiKey);
        writeSetupConfig(serverUrl, apiKey);
        writeCursorConfig(serverUrl, apiKey);

        console.log(`Configured Vega client for ${serverUrl}.`);
        console.log("Reload Cursor to load the updated MCP configuration.");
      }
    );
}
