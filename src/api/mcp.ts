import { Router, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { isAuthorizedBearerRequest } from "./auth.js";
import type { APIRouterServices } from "./routes.js";
import type {
  GraphNeighborsResult,
  GraphPathResult,
  GraphQueryResult,
  GraphStats,
  GraphSubgraphResult,
  HealthInfo
} from "../core/types.js";
import { createMCPServer } from "../mcp/server.js";
import { getHealthReport } from "../core/health.js";
import type { VegaConfig } from "../config.js";

const createGraphServiceStub = (): CreateGraphServiceStub => ({
  query: async (): Promise<GraphQueryResult> => ({
    entity: null,
    relations: [],
    memories: []
  }),
  getNeighbors: async (): Promise<GraphNeighborsResult> => ({
    entity: null,
    neighbors: [],
    relations: [],
    memories: []
  }),
  shortestPath: async (): Promise<GraphPathResult> => ({
    from: null,
    to: null,
    entities: [],
    relations: [],
    memories: [],
    found: false
  }),
  graphStats: async (): Promise<GraphStats> => ({
    total_entities: 0,
    total_relations: 0,
    entity_types: {},
    relation_types: {},
    average_confidence: null,
    tracked_code_files: 0,
    tracked_doc_files: 0
  }),
  subgraph: async (): Promise<GraphSubgraphResult> => ({
    seed_entities: [],
    missing_entities: [],
    entities: [],
    relations: [],
    memories: []
  })
});

type CreateGraphServiceStub = {
  query(): Promise<GraphQueryResult>;
  getNeighbors(): Promise<GraphNeighborsResult>;
  shortestPath(): Promise<GraphPathResult>;
  graphStats(): Promise<GraphStats>;
  subgraph(): Promise<GraphSubgraphResult>;
};

export const createMcpRouter = (
  services: Omit<APIRouterServices, "config">,
  config: VegaConfig
): Router => {
  const router = Router();

  router.all("/mcp", async (req: Request, res: Response) => {
    if (!isAuthorizedBearerRequest(req, res, config, services.repository)) {
      res.status(401).json({
        error: "Unauthorized"
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    const server = createMCPServer({
      repository: services.repository,
      graphService: createGraphServiceStub(),
      memoryService: services.memoryService,
      recallService: services.recallService,
      sessionService: services.sessionService,
      compactService: services.compactService,
      config,
      healthProvider: async (): Promise<HealthInfo> =>
        getHealthReport(services.repository, config)
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await server.close();
    }
  });

  return router;
};
