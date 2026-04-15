import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express, { type Express, type Request, type Response, type NextFunction } from "express";

import type { VegaConfig } from "../config.js";
import {
  createAuthMiddleware,
  getBearerToken,
  getRequestTenantId,
  matchesConfiguredApiKey
} from "./auth.js";
import { createMcpRouter } from "./mcp.js";
import { createOidcRouter } from "./oidc.js";
import { createRouter, type APIRouterServices } from "./routes.js";
import { StructuredLogger } from "../monitoring/logger.js";
import { MetricsCollector } from "../monitoring/metrics.js";
import { SentryStub } from "../monitoring/sentry.js";

const isAddressInfo = (value: string | AddressInfo | null): value is AddressInfo =>
  typeof value === "object" && value !== null;

const shouldLogApiRequest = (path: string): boolean => path.startsWith("/api") && path !== "/api/health";

const UUID_SEGMENT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizePathSegment = (segment: string): string => {
  if (UUID_SEGMENT_PATTERN.test(segment)) {
    return ":id";
  }

  if (/^\d+$/.test(segment)) {
    return ":n";
  }

  return segment;
};

export const getMetricsPathLabel = (req: Request): string => {
  if (req.route?.path && typeof req.route.path === "string") {
    return `${req.baseUrl}${req.route.path}` || req.route.path;
  }

  return req.path
    .split("/")
    .map((segment) => normalizePathSegment(segment))
    .join("/");
};

export function createAPIServer(
  services: Omit<APIRouterServices, "config">,
  config: VegaConfig
): {
  app: Express;
  start(port: number): Promise<number>;
  stop(): Promise<void>;
} {
  const app = express();
  let server: Server | null = null;
  const logger = new StructuredLogger({
    level: config.logLevel ?? "info",
    format: config.logFormat ?? "json",
    service: "vega-memory"
  });
  const metrics = new MetricsCollector({
    enabled: config.metricsEnabled ?? false,
    prefix: "vega"
  });
  const sentry = new SentryStub({
    dsn: config.sentryDsn,
    environment: config.mode,
    enabled: Boolean(config.sentryDsn)
  });
  const requestCounter = metrics.counter("http_requests_total", "Total HTTP requests", ["method", "path", "status"]);
  const requestLatency = metrics.histogram("http_request_duration_seconds", "HTTP request duration", [0.05, 0.1, 0.5, 1, 2, 5], ["method", "path"]);

  app.use(
    "/api/billing/webhook",
    express.text({
      type: "*/*",
      limit: "10mb"
    })
  );
  app.use(
    express.json({
      limit: "10mb"
    })
  );
  app.use((req, res, next) => {
    if (!shouldLogApiRequest(req.path)) {
      next();
      return;
    }

    const startedAt = Date.now();
    res.once("finish", () => {
      const durationSeconds = (Date.now() - startedAt) / 1000;
      const metricsPath = getMetricsPathLabel(req);

      requestCounter.inc({
        method: req.method.toUpperCase(),
        path: metricsPath,
        status: String(res.statusCode)
      });
      requestLatency.observe(durationSeconds, {
        method: req.method.toUpperCase(),
        path: metricsPath
      });
      services.repository.logPerformance({
        timestamp: new Date().toISOString(),
        tenant_id: getRequestTenantId(res),
        operation: `${req.method.toUpperCase()} ${req.path}`,
        latency_ms: Date.now() - startedAt,
        memory_count: 0,
        result_count: 0
      });
      logger.debug("http request", {
        method: req.method.toUpperCase(),
        path: req.path,
        status: res.statusCode,
        latency_ms: Date.now() - startedAt
      });
    });

    next();
  });
  app.get("/metrics", async (req, res) => {
    if (!(config.metricsEnabled ?? false)) {
      res.status(404).send("metrics disabled");
      return;
    }

    if ((config.metricsRequireAuth ?? true) && config.apiKey !== undefined) {
      const token = getBearerToken(req);
      if (token === undefined || !matchesConfiguredApiKey(token, config.apiKey)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    res.type("text/plain").send(await metrics.getMetrics());
  });
  app.use(createOidcRouter(config, services.repository));
  app.use(createAuthMiddleware(config, services.repository));
  if (config.apiKey !== undefined) {
    app.use(createMcpRouter(services, config));
  }
  app.use(
    createRouter({
      ...services,
      config
    })
  );
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof Error) {
      sentry.captureException(error, {
        route: _req.path
      });
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({
        error: "invalid json"
      });
      return;
    }

    next(error);
  });

  return {
    app,
    async start(port: number): Promise<number> {
      if (server !== null) {
        const address = server.address();
        if (!isAddressInfo(address)) {
          throw new Error("HTTP API server address is unavailable");
        }

        return address.port;
      }

      const nextServer = await new Promise<Server>((resolve, reject) => {
        const startedServer = app.listen(port, () => {
          resolve(startedServer);
        });

        startedServer.once("error", reject);
      });

      server = nextServer;
      const address = nextServer.address();
      if (!isAddressInfo(address)) {
        throw new Error("HTTP API server address is unavailable");
      }

      return address.port;
    },
    async stop(): Promise<void> {
      if (server === null) {
        return;
      }

      const nextServer = server;
      server = null;

      await new Promise<void>((resolve, reject) => {
        nextServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}
