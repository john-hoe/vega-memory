import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express, { type Express, type Request, type Response, type NextFunction } from "express";

import type { VegaConfig } from "../config.js";
import { createAuthMiddleware, getRequestTenantId } from "./auth.js";
import { createRouter, type APIRouterServices } from "./routes.js";

const isAddressInfo = (value: string | AddressInfo | null): value is AddressInfo =>
  typeof value === "object" && value !== null;

const shouldLogApiRequest = (path: string): boolean => path.startsWith("/api") && path !== "/api/health";

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
      services.repository.logPerformance({
        timestamp: new Date().toISOString(),
        tenant_id: getRequestTenantId(res),
        operation: `${req.method.toUpperCase()} ${req.path}`,
        latency_ms: Date.now() - startedAt,
        memory_count: 0,
        result_count: 0
      });
    });

    next();
  });
  app.use(createAuthMiddleware(config, services.repository));
  app.use(
    createRouter({
      ...services,
      config
    })
  );
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
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
