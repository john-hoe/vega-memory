import { Command } from "commander";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";

import {
  KNOWN_INSECURE_API_KEYS,
  type VegaConfig
} from "../../config.js";
import { isOllamaAvailable } from "../../embedding/ollama.js";
import {
  buildIntegrationSurfaceStatuses,
  openRepositoryForSurfaceStatus
} from "../../core/integration-surface-status.js";
import type { IntegrationSurfaceStatus } from "../../core/types.js";
import { ensureNodeCommand } from "./setup.js";

type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  summary: string;
  details: string[];
  fix?: string;
}

export interface DoctorReport {
  status: DoctorCheckStatus;
  checks: DoctorCheck[];
  suggestions: string[];
  surfaces: IntegrationSurfaceStatus[];
}

const isHomeOverrideActive = (): boolean => {
  const homeOverride = process.env.HOME;

  if (!homeOverride) {
    return false;
  }

  return resolve(homeOverride) !== resolve(userInfo().homedir ?? homedir());
};

const buildModeCheck = (config: VegaConfig): DoctorCheck => {
  if (config.mode === "client") {
    if (!config.serverUrl) {
      return {
        name: "mode",
        status: "fail",
        summary: "client mode is enabled but VEGA_SERVER_URL is missing",
        details: ["Set VEGA_SERVER_URL or rerun `vega setup --server <host> --cursor`."],
        fix: "Configure VEGA_SERVER_URL for client mode, or switch VEGA_MODE back to server for local-only operation."
      };
    }

    return {
      name: "mode",
      status: "pass",
      summary: `client mode points at ${config.serverUrl}`,
      details: [`cache DB: ${config.cacheDbPath}`]
    };
  }

  return {
    name: "mode",
    status: "pass",
    summary: `server mode on port ${config.apiPort}`,
    details: [`database path: ${config.dbPath}`]
  };
};

const buildApiKeyCheck = (config: VegaConfig): DoctorCheck => {
  if (config.mode === "client") {
    if (!config.apiKey) {
      return {
        name: "api_key",
        status: "fail",
        summary: "client mode is missing VEGA_API_KEY",
        details: ["Client mode needs the server bearer token to reach the remote API."],
        fix: "Set VEGA_API_KEY or rerun `vega setup --server <host> --cursor --api-key <key>`."
      };
    }

    return {
      name: "api_key",
      status: "pass",
      summary: "client API key is configured",
      details: ["Remote client requests can authenticate against the server."]
    };
  }

  if (!config.apiKey) {
    return {
      name: "api_key",
      status: "warn",
      summary: "VEGA_API_KEY is not configured",
      details: ["Local CLI and local MCP stdio can still work, but dashboard, HTTP API, and remote clients stay unavailable."],
      fix: "Set VEGA_API_KEY before exposing the HTTP API, dashboard, or shared remote access."
    };
  }

  if (KNOWN_INSECURE_API_KEYS.has(config.apiKey)) {
    return {
      name: "api_key",
      status: "warn",
      summary: "VEGA_API_KEY uses a known insecure default",
      details: ["The configured key is suitable for local demos but not for shared environments."],
      fix: "Replace VEGA_API_KEY with a random secret before using HTTP, dashboard, or remote-client workflows."
    };
  }

  return {
    name: "api_key",
    status: "pass",
    summary: "VEGA_API_KEY is configured",
    details: ["HTTP API, dashboard, and remote clients can authenticate."]
  };
};

const buildOllamaCheck = async (config: VegaConfig): Promise<DoctorCheck> => {
  if (config.embeddingProvider && config.embeddingProvider !== "ollama") {
    return {
      name: "ollama",
      status: "pass",
      summary: `embedding provider is ${config.embeddingProvider}; Ollama is optional here`,
      details: [`configured provider: ${config.embeddingProvider}`]
    };
  }

  const available = await isOllamaAvailable(config);

  if (available) {
    return {
      name: "ollama",
      status: "pass",
      summary: `Ollama is reachable at ${config.ollamaBaseUrl}`,
      details: [`model: ${config.ollamaModel}`]
    };
  }

  return {
    name: "ollama",
    status: "fail",
    summary: `Ollama is unavailable at ${config.ollamaBaseUrl}`,
    details: [`expected model: ${config.ollamaModel}`],
    fix: "Start Ollama, verify `/api/version` responds at the configured base URL, or switch VEGA_EMBEDDING_PROVIDER to a non-Ollama provider."
  };
};

export async function runDoctor(config: VegaConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const repository = await openRepositoryForSurfaceStatus(config);

  try {
    const nodeVersion = ensureNodeCommand();
    checks.push({
      name: "node",
      status: "pass",
      summary: `Node.js command is available (${nodeVersion})`,
      details: [`runtime version: ${process.version}`]
    });
  } catch (error) {
    checks.push({
      name: "node",
      status: "fail",
      summary: error instanceof Error ? error.message : String(error),
      details: ["Cursor remote-client setup and other Node-launched integrations depend on a working `node` command."],
      fix: "Install Node.js 18+ (20 LTS recommended) and make sure `node` is available on PATH."
    });
  }

  checks.push(buildModeCheck(config));
  checks.push(buildApiKeyCheck(config));
  checks.push(await buildOllamaCheck(config));

  const surfaces = await buildIntegrationSurfaceStatuses(
    isHomeOverrideActive()
      ? { config }
      : {
          config,
          repository
        }
  );
  checks.push({
    name: "integration_surfaces",
    status: surfaces.some((surface) => surface.runtime_health_status === "fail")
      ? "fail"
      : surfaces.some(
            (surface) =>
              surface.managed_setup_status !== "configured" ||
              surface.observed_activity_status !== "active" ||
              surface.runtime_health_status !== "ok"
          )
        ? "warn"
        : "pass",
    summary: "evaluated surfaces with managed setup, observed activity, and runtime health semantics",
    details: surfaces.map(
      (surface) =>
        `${surface.surface}: managed=${surface.managed_setup_status}, observed7d=${surface.observed_activity_windows.window_7d.status}, runtime=${surface.runtime_health_status}`
    ),
    fix:
      "Use `vega setup --show` for the full tri-dimensional view and follow each surface's next_action when the current state is missing, inactive, or unhealthy."
  });

  const overallStatus = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  return {
    status: overallStatus,
    checks,
    suggestions: [...new Set(checks.flatMap((check) => (check.fix ? [check.fix] : [])))],
    surfaces
  };
}

export function registerDoctorCommand(program: Command, config: VegaConfig): void {
  program
    .command("doctor")
    .description("Check onboarding and agent integration health")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      const report = await runDoctor(config);

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`status: ${report.status}`);
        console.log("surfaces:");
        for (const surface of report.surfaces) {
          console.log(
            `- ${surface.surface}: managed=${surface.managed_setup_status}, observed7d=${surface.observed_activity_windows.window_7d.status}, observed30d=${surface.observed_activity_windows.window_30d.status}, runtime=${surface.runtime_health_status}`
          );
          if (surface.next_action) {
            console.log(`  next_action: ${surface.next_action}`);
          }
        }

        for (const check of report.checks) {
          console.log(`${check.name}: ${check.status} — ${check.summary}`);
          for (const detail of check.details) {
            console.log(`  - ${detail}`);
          }
        }

        if (report.suggestions.length > 0) {
          console.log("suggestions:");
          for (const suggestion of report.suggestions) {
            console.log(`- ${suggestion}`);
          }
        }
      }

      if (report.status === "fail") {
        process.exitCode = 1;
      }
    });
}
