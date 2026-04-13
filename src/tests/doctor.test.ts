import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = process.cwd();
const childBaseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("VEGA_") && key !== "OLLAMA_BASE_URL" && key !== "OLLAMA_MODEL"
  )
);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const runCli = (
  args: string[],
  homeDirectory: string,
  envOverrides: Record<string, string | undefined> = {}
): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const cliPath = join(projectRoot, "dist", "cli", "index.js");
    const cliModuleUrl = pathToFileURL(cliPath).href;
    const cliBootstrap = `process.argv.splice(1, 0, ${JSON.stringify(cliPath)}); await import(${JSON.stringify(cliModuleUrl)});`;
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
      resolve({ status, stdout, stderr });
    });
  });

const startOllamaServer = async (): Promise<{
  baseUrl: string;
  stop(): Promise<void>;
}> => {
  const server = createServer((req, res) => {
    if (req.url !== "/api/version") {
      res.statusCode = 404;
      res.end();
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version: "0.5.0" }));
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
    baseUrl: `http://127.0.0.1:${port}`,
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

test("doctor --json reports a healthy onboarding setup when core checks pass", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "vega-doctor-pass-"));
  const codexDirectory = join(homeDirectory, ".codex");
  const codexRulesPath = join(codexDirectory, "AGENTS.md");
  const ollama = await startOllamaServer();

  mkdirSync(codexDirectory, { recursive: true });
  writeFileSync(
    codexRulesPath,
    [
      "<!-- Vega Memory System: START -->",
      "Rules for Codex CLI:",
      "- use vega CLI",
      "<!-- Vega Memory System: END -->",
      ""
    ].join("\n"),
    "utf8"
  );

  try {
    const result = await runCli(["doctor", "--json"], homeDirectory, {
      OLLAMA_BASE_URL: ollama.baseUrl,
      VEGA_API_KEY: "doctor-secret"
    });
    const report = JSON.parse(result.stdout) as {
      status: string;
      checks: Array<{ name: string; status: string; summary: string }>;
      surfaces: Array<{
        surface: string;
        managed_setup_status: string;
        observed_activity_windows: {
          window_7d: { status: string };
        };
      }>;
    };

    assert.equal(result.status, 0);
    assert.equal(report.status, "warn");
    assert.equal(report.checks.some((check) => check.name === "integration_surfaces" && check.status === "warn"), true);
    assert.equal(report.checks.some((check) => check.name === "ollama" && check.status === "pass"), true);
    assert.equal(report.surfaces.some((surface) => surface.surface === "codex" && surface.managed_setup_status === "configured"), true);
    assert.equal(report.surfaces.some((surface) => surface.surface === "codex" && surface.observed_activity_windows.window_7d.status === "unknown"), true);
  } finally {
    await ollama.stop();
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});

test("doctor fails in client mode when remote configuration is incomplete", async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), "vega-doctor-fail-"));
  const ollama = await startOllamaServer();

  try {
    const result = await runCli(["doctor", "--json"], homeDirectory, {
      OLLAMA_BASE_URL: ollama.baseUrl,
      VEGA_MODE: "client"
    });
    const report = JSON.parse(result.stdout) as {
      status: string;
      suggestions: string[];
      checks: Array<{ name: string; status: string }>;
      surfaces: Array<{ surface: string; runtime_health_status: string }>;
    };

    assert.equal(result.status, 1);
    assert.equal(report.status, "fail");
    assert.equal(report.checks.some((check) => check.name === "mode" && check.status === "fail"), true);
    assert.equal(report.checks.some((check) => check.name === "api_key" && check.status === "fail"), true);
    assert.equal(report.suggestions.length > 0, true);
    assert.equal(report.surfaces.some((surface) => surface.surface === "api" && surface.runtime_health_status === "fail"), true);
  } finally {
    await ollama.stop();
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});
