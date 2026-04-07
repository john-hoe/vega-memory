import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");
const cliModuleUrl = pathToFileURL(cliPath).href;
const expectedMcpEntryPath = join(projectRoot, "dist", "index.js");
const childBaseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("VEGA_") && key !== "OLLAMA_BASE_URL" && key !== "OLLAMA_MODEL"
  )
);
const cliBootstrap = `process.argv.splice(1, 0, ${JSON.stringify(cliPath)}); await import(${JSON.stringify(cliModuleUrl)});`;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const bundledCursorRulesPath = join(projectRoot, "rules", "cursor-memory.mdc");
const bundledSnapshotPath = join(projectRoot, "data", "vega-memory-snapshot.md");

const runCli = (
  args: string[],
  homeDirectory: string,
  envOverrides: Record<string, string | undefined> = {}
): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", cliBootstrap, "--", ...args],
      {
        cwd: projectRoot,
        env: {
          ...childBaseEnv,
          HOME: homeDirectory,
          ...envOverrides
        }
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({
        status,
        stdout,
        stderr
      });
    });
  });

const readJsonFile = <T>(filePath: string): T =>
  JSON.parse(readFileSync(filePath, "utf8")) as T;

const startHealthServer = async ({
  apiKey,
  requireAuthorization = true
}: {
  apiKey?: string;
  requireAuthorization?: boolean;
} = {}): Promise<{
  port: number;
  stop(): Promise<void>;
}> => {
  const server = createServer((req, res) => {
    if (req.url !== "/api/health") {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (
      requireAuthorization &&
      req.headers.authorization !== `Bearer ${apiKey ?? ""}`
    ) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        status: "healthy",
        ollama: false,
        db_integrity: true,
        memories: 0,
        latency_avg_ms: 0,
        db_size_mb: 0,
        last_backup: null,
        issues: [],
        fix_suggestions: []
      })
    );
  });

  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve((server.address() as { port: number }).port);
    });
  });

  return {
    port,
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
};

test("setup --server reports an unreachable Vega server", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "vega-setup-unreachable-"));

  try {
    const result = await runCli(
      ["setup", "--server", "127.0.0.1", "--port", "9"],
      homeDirectory
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot reach Vega server at http:\/\/127\.0\.0\.1:9/);
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});

test("setup --server fails when the node command is unavailable for Cursor MCP", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "vega-setup-node-check-"));

  try {
    const result = await runCli(
      ["setup", "--server", "127.0.0.1", "--port", "3271"],
      homeDirectory,
      {
        PATH: ""
      }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Node\.js command `node` is required on PATH for Cursor MCP\./);
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});

test("setup --server writes Vega, Cursor, rules, and snapshot files with an explicit API key", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "vega-setup-success-"));
  const apiKey = "remote-secret";
  const cursorDirectory = join(homeDirectory, ".cursor");
  const cursorConfigPath = join(cursorDirectory, "mcp.json");
  const cursorRulesPath = join(cursorDirectory, "rules", "memory.mdc");
  const vegaConfigPath = join(homeDirectory, ".vega", "config.json");
  const snapshotPath = join(homeDirectory, ".vega", "snapshot.md");
  const server = await startHealthServer({ apiKey });

  mkdirSync(cursorDirectory, { recursive: true });
  writeFileSync(
    cursorConfigPath,
    `${JSON.stringify(
      {
        mcpServers: {
          existing: {
            command: "node",
            args: ["/tmp/existing.js"]
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  try {
    const result = await runCli(
      [
        "setup",
        "--server",
        "127.0.0.1",
        "--port",
        String(server.port),
        "--api-key",
        apiKey
      ],
      homeDirectory
    );

    const vegaConfig = readJsonFile<{
      mode: string;
      server: string;
      api_key: string;
      cache_db: string;
      sync_interval_minutes: number;
    }>(vegaConfigPath);
    const cursorConfig = readJsonFile<{
      mcpServers: Record<string, unknown>;
    }>(cursorConfigPath);
    const vegaEntry = cursorConfig.mcpServers.vega as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Node\.js check passed: v\d+\.\d+\.\d+/);
    assert.match(result.stdout, /Reload Cursor/);
    assert.deepEqual(vegaConfig, {
      mode: "client",
      server: `http://127.0.0.1:${server.port}`,
      api_key: apiKey,
      cache_db: "~/.vega/cache.db",
      sync_interval_minutes: 5
    });
    assert.deepEqual(cursorConfig.mcpServers.existing, {
      command: "node",
      args: ["/tmp/existing.js"]
    });
    assert.deepEqual(vegaEntry, {
      command: "node",
      args: [expectedMcpEntryPath],
      env: {
        VEGA_MODE: "client",
        VEGA_SERVER_URL: `http://127.0.0.1:${server.port}`,
        VEGA_API_KEY: apiKey,
        VEGA_CACHE_DB: "~/.vega/cache.db"
      }
    });
    assert.equal(readFileSync(cursorRulesPath, "utf8"), readFileSync(bundledCursorRulesPath, "utf8"));
    assert.equal(readFileSync(snapshotPath, "utf8"), readFileSync(bundledSnapshotPath, "utf8"));
  } finally {
    await server.stop();
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});

test("setup --server auto-generates a vega_ API key when none is provided", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "vega-setup-generated-key-"));
  const vegaConfigPath = join(homeDirectory, ".vega", "config.json");
  const cursorConfigPath = join(homeDirectory, ".cursor", "mcp.json");
  const server = await startHealthServer({
    requireAuthorization: false
  });

  try {
    const result = await runCli(
      ["setup", "--server", "127.0.0.1", "--port", String(server.port)],
      homeDirectory
    );

    const vegaConfig = readJsonFile<{
      api_key: string;
      server: string;
    }>(vegaConfigPath);
    const cursorConfig = readJsonFile<{
      mcpServers: Record<string, unknown>;
    }>(cursorConfigPath);
    const vegaEntry = cursorConfig.mcpServers.vega as {
      env: Record<string, string>;
    };

    assert.equal(result.status, 0);
    assert.match(vegaConfig.api_key, /^vega_[0-9a-f]{48}$/);
    assert.equal(vegaConfig.server, `http://127.0.0.1:${server.port}`);
    assert.equal(vegaEntry.env.VEGA_API_KEY, vegaConfig.api_key);
    assert.match(result.stdout, new RegExp(`Generated API key: ${vegaConfig.api_key}`));
  } finally {
    await server.stop();
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});
