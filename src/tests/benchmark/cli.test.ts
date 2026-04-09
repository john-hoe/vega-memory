import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");
const cliModuleUrl = pathToFileURL(cliPath).href;
const childBaseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("VEGA_") && key !== "OLLAMA_BASE_URL" && key !== "OLLAMA_MODEL"
  )
);
const cliBootstrap = `process.argv.splice(1, 0, ${JSON.stringify(cliPath)}); await import(${JSON.stringify(cliModuleUrl)});`;

const runCli = (args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync(process.execPath, ["--input-type=module", "-e", cliBootstrap, "--", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...childBaseEnv,
      ...env
    }
  });

test("CLI benchmark run/report persist and return the latest suite result", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-benchmark-cli-"));
  const env = {
    VEGA_DB_PATH: join(tempDir, "memory.db"),
    OLLAMA_BASE_URL: "http://localhost:99999"
  };

  try {
    const runReport = JSON.parse(runCli(["benchmark", "run", "--json"], env)) as {
      run_id: string;
      files: {
        json: string;
        markdown: string;
      };
      summary: {
        total_checks: number;
      };
    };
    const latestReport = JSON.parse(runCli(["benchmark", "report", "--json"], env)) as {
      run_id: string;
      files: {
        json: string;
        markdown: string;
      };
    };

    assert.equal(runReport.summary.total_checks > 0, true);
    assert.equal(runReport.files.json.endsWith(".json"), true);
    assert.equal(runReport.files.markdown.endsWith(".md"), true);
    assert.equal(latestReport.run_id, runReport.run_id);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
