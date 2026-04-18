import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express, { type Express, type Request, type Response, type NextFunction } from "express";

import type { VegaConfig } from "../config.js";
import { ArchiveService } from "../core/archive-service.js";
import { FactClaimService } from "../core/fact-claim-service.js";
import { GraphReportService } from "../core/graph-report.js";
import type { Memory } from "../core/types.js";
import { MemoryService } from "../core/memory.js";
import { SessionService } from "../core/session.js";
import { createCandidateRepository } from "../db/candidate-repository.js";
import { createShadowAwareRepository } from "../db/shadow-aware-repository.js";
import {
  createAuthMiddleware,
  getBearerToken,
  getRequestTenantId,
  isAuthorizedRequest,
  matchesConfiguredApiKey
} from "./auth.js";
import { applyRawInboxMigration } from "../ingestion/raw-inbox.js";
import { memoryToEnvelope } from "../ingestion/memory-to-envelope.js";
import { createIngestEventHttpHandler } from "../ingestion/ingest-event-handler.js";
import { createShadowWriter } from "../ingestion/shadow-writer.js";
import { createMcpRouter } from "./mcp.js";
import { createOidcRouter } from "./oidc.js";
import { createRouter, type APIRouterServices } from "./routes.js";
import { StructuredLogger } from "../monitoring/logger.js";
import { MetricsCollector } from "../monitoring/metrics.js";
import { SentryStub } from "../monitoring/sentry.js";
import { createContextResolveHttpHandler } from "../retrieval/context-resolve-handler.js";
import { createDefaultRegistry } from "../retrieval/orchestrator-config.js";
import { RetrievalOrchestrator } from "../retrieval/orchestrator.js";
import { createCandidateMemoryAdapter } from "../retrieval/sources/candidate-memory.js";
import { SourceRegistry } from "../retrieval/sources/registry.js";
import {
  createAckStore,
  createCheckpointFailureStore,
  createCheckpointStore
} from "../usage/index.js";
import { buildPhase8Status } from "../usage/phase8-status.js";
import { createUsageAckHttpHandler } from "../usage/usage-ack-handler.js";
import { searchWikiPages } from "../wiki/search.js";

const isAddressInfo = (value: string | AddressInfo | null): value is AddressInfo =>
  typeof value === "object" && value !== null;

const shouldLogApiRequest = (path: string): boolean =>
  path.startsWith("/api") &&
  path !== "/api/health" &&
  path !== "/api/phase8_status";

function createRetrievalRegistry(deps: Parameters<typeof createDefaultRegistry>[0]): SourceRegistry {
  const baseRegistry = createDefaultRegistry(deps);

  if (deps.repository === undefined || deps.repository.db.isPostgres) {
    return baseRegistry;
  }

  const registry = new SourceRegistry();
  const candidateRepository = createCandidateRepository(deps.repository.db);

  for (const adapter of baseRegistry.list()) {
    if (adapter.kind === "candidate") {
      continue;
    }

    registry.register(adapter);
  }

  registry.register(
    createCandidateMemoryAdapter({
      repository: candidateRepository
    })
  );

  return registry;
}

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
  let activeServices = services;
  let db = activeServices.repository.db;

  if (!db.isPostgres) {
    applyRawInboxMigration(db);
    const shadowWrite = createShadowWriter({ db });
    const activeRepository = createShadowAwareRepository(activeServices.repository, shadowWrite);
    const shadowWriteForMemoryService = (memory: Memory): void => {
      try {
        const outcome = shadowWrite(
          memoryToEnvelope(memory, {
            default_surface: "api"
          })
        );

        if (outcome.executed && outcome.reason === "error") {
          logger.warn("MemoryService shadow write failed", {
            memory_id: memory.id,
            error: outcome.error ?? "unknown error"
          });
        }
      } catch (error) {
        logger.warn("MemoryService shadow write throw caught", {
          memory_id: memory.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };
    const activeMemoryService = new MemoryService(
      activeRepository,
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      shadowWriteForMemoryService
    );
    const activeSessionService = new SessionService(
      activeRepository,
      activeMemoryService,
      activeServices.recallService,
      config
    );

    activeServices = {
      ...activeServices,
      repository: activeRepository,
      memoryService: activeMemoryService,
      sessionService: activeSessionService
    };
    db = activeRepository.db;
  }

  const factClaimService = new FactClaimService(activeServices.repository, config);
  const graphReportService = new GraphReportService(activeServices.repository);
  const archiveService = new ArchiveService(activeServices.repository, config);
  const requireAuthorizedHttpRoute: express.RequestHandler = (req, res, next) => {
    if (isAuthorizedRequest(req, res, config, activeServices.repository)) {
      next();
      return;
    }

    res.status(401).json({
      error: "unauthorized"
    });
  };
  const checkpointStore = !db.isPostgres ? createCheckpointStore(db) : undefined;
  const ackStore = !db.isPostgres ? createAckStore(db) : undefined;
  const checkpointFailureStore = !db.isPostgres ? createCheckpointFailureStore(db) : undefined;
  const phase8Status = (): ReturnType<typeof buildPhase8Status> =>
    buildPhase8Status({
      isPostgres: db.isPostgres,
      checkpointStore,
      ackStore,
      checkpointFailureStore
    });

  if (db.isPostgres) {
    logger.warn(
      "Phase 8 persistence disabled: CheckpointStore, AckStore, CheckpointFailureStore require SQLite backend. context.resolve/usage.ack still accept traffic but responses carry degraded flags."
    );
  }
  const retrievalOrchestrator = new RetrievalOrchestrator({
    registry: createRetrievalRegistry({
      repository: activeServices.repository,
      wikiSearch: searchWikiPages,
      factClaimService,
      graphReportService,
      archiveService
    }),
    checkpoint_store: checkpointStore,
    checkpoint_failure_store: checkpointFailureStore
  });

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
      activeServices.repository.logPerformance({
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
  app.get("/api/phase8_status", (_req, res) => {
    res.status(200).json(phase8Status());
  });
  app.use(createOidcRouter(config, activeServices.repository));
  app.use(createAuthMiddleware(config, activeServices.repository));
  if (config.apiKey !== undefined) {
    app.use(createMcpRouter(activeServices, config));
  }
  app.use(["/ingest_event", "/context_resolve", "/usage_ack"], requireAuthorizedHttpRoute);
  app.post("/ingest_event", createIngestEventHttpHandler(db));
  app.post("/context_resolve", createContextResolveHttpHandler(retrievalOrchestrator));
  app.post("/usage_ack", createUsageAckHttpHandler(ackStore, checkpointStore));
  app.use(
    createRouter({
      ...activeServices,
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
