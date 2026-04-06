import { Router, type Request, type RequestHandler, type Response } from "express";

import type { VegaConfig } from "../config.js";
import { AnalyticsService } from "../core/analytics.js";
import { CompactService } from "../core/compact.js";
import { getHealthReport } from "../core/health.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import type {
  AuditContext,
  Memory,
  MemorySource,
  MemoryType,
  SearchResult,
  SessionStartResult
} from "../core/types.js";
import { Repository } from "../db/repository.js";
import { PageManager } from "../wiki/page-manager.js";
import { searchWikiPages } from "../wiki/search.js";
import {
  WIKI_PAGE_STATUSES,
  WIKI_PAGE_TYPES,
  type PageWithBacklinks,
  type WikiPage,
  type WikiPageStatus,
  type WikiPageType,
  type WikiPageVersion
} from "../wiki/types.js";

const MEMORY_TYPES = new Set<MemoryType>([
  "task_state",
  "preference",
  "project_context",
  "decision",
  "pitfall",
  "insight"
]);

const MEMORY_SOURCES = new Set<MemorySource>(["auto", "explicit"]);
const WIKI_PAGE_TYPE_VALUES = new Set<WikiPageType>(WIKI_PAGE_TYPES);
const WIKI_PAGE_STATUS_VALUES = new Set<WikiPageStatus>(WIKI_PAGE_STATUSES);

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface APIRouterServices {
  repository: Repository;
  memoryService: MemoryService;
  recallService: RecallService;
  sessionService: SessionService;
  compactService: CompactService;
  config: VegaConfig;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const serializeMemory = (memory: Memory) => ({
  id: memory.id,
  type: memory.type,
  project: memory.project,
  title: memory.title,
  content: memory.content,
  importance: memory.importance,
  source: memory.source,
  tags: memory.tags,
  created_at: memory.created_at,
  updated_at: memory.updated_at,
  accessed_at: memory.accessed_at,
  access_count: memory.access_count,
  status: memory.status,
  verified: memory.verified,
  scope: memory.scope,
  accessed_projects: memory.accessed_projects
});

const serializeSessionStartResult = (result: SessionStartResult) => ({
  project: result.project,
  active_tasks: result.active_tasks.map(serializeMemory),
  preferences: result.preferences.map(serializeMemory),
  context: result.context.map(serializeMemory),
  relevant: result.relevant.map(serializeMemory),
  relevant_wiki_pages: result.relevant_wiki_pages,
  wiki_drafts_pending: result.wiki_drafts_pending,
  recent_unverified: result.recent_unverified.map(serializeMemory),
  conflicts: result.conflicts.map(serializeMemory),
  proactive_warnings: result.proactive_warnings,
  token_estimate: result.token_estimate
});

const serializeSearchResult = (result: SearchResult) => ({
  ...serializeMemory(result.memory),
  similarity: result.similarity,
  finalScore: result.finalScore
});

const serializeWikiPageListEntry = (page: WikiPage) => ({
  id: page.id,
  slug: page.slug,
  title: page.title,
  page_type: page.page_type,
  status: page.status,
  project: page.project,
  updated_at: page.updated_at,
  summary: page.summary
});

const serializeWikiPage = (page: WikiPage) => ({
  id: page.id,
  slug: page.slug,
  title: page.title,
  content: page.content,
  summary: page.summary,
  page_type: page.page_type,
  scope: page.scope,
  project: page.project,
  tags: page.tags,
  source_memory_ids: page.source_memory_ids,
  status: page.status,
  auto_generated: page.auto_generated,
  reviewed: page.reviewed,
  version: page.version,
  parent_id: page.parent_id,
  sort_order: page.sort_order,
  created_at: page.created_at,
  updated_at: page.updated_at,
  reviewed_at: page.reviewed_at,
  published_at: page.published_at
});

const serializePageWithBacklinks = (result: PageWithBacklinks) => ({
  page: serializeWikiPage(result.page),
  backlinks: result.backlinks
});

const serializeWikiPageVersion = (version: WikiPageVersion) => version;

const flushResponse = (res: Response): void => {
  (res as Response & { flush?: () => void }).flush?.();
};

const writeSseEvent = (res: Response, data: unknown, event?: "end" | "error"): void => {
  if (event) {
    res.write(`event: ${event}\n`);
  }

  const lines = JSON.stringify(data).split(/\r\n|\r|\n/u);
  for (const line of lines) {
    res.write(`data: ${line}\n`);
  }

  res.write("\n");
  flushResponse(res);
};

const getErrorResponse = (error: unknown): { status: number; message: string } => {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      message: error.message
    };
  }

  if (error instanceof Error) {
    if (
      error.message.startsWith("Memory not found:") ||
      error.message.startsWith("Unsupported sort")
    ) {
      return {
        status: 400,
        message: error.message
      };
    }

    return {
      status: 500,
      message: error.message
    };
  }

  return {
    status: 500,
    message: String(error)
  };
};

const handleRoute =
  (handler: RequestHandler): RequestHandler =>
  (req, res, next) => {
    void Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error: unknown) => {
        const { status, message } = getErrorResponse(error);
        res.status(status).json({
          error: message
        });
      });
  };

const requireBody = (body: unknown): Record<string, unknown> => {
  if (!isRecord(body)) {
    throw new ApiError(400, "request body must be a JSON object");
  }

  return body;
};

const parseSingleValue = (value: unknown, field: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
    return parseSingleValue(value[0], field);
  }

  throw new ApiError(400, `${field} must be a string`);
};

const requireString = (value: unknown, field: string): string => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    throw new ApiError(400, `${field} is required`);
  }

  return parsed;
};

const parseNumber = (
  value: unknown,
  field: string,
  options?: {
    integer?: boolean;
    min?: number;
    max?: number;
  }
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ApiError(400, `${field} must be a number`);
  }

  if (options?.integer && !Number.isInteger(value)) {
    throw new ApiError(400, `${field} must be an integer`);
  }

  if (options?.min !== undefined && value < options.min) {
    throw new ApiError(400, `${field} must be at least ${options.min}`);
  }

  if (options?.max !== undefined && value > options.max) {
    throw new ApiError(400, `${field} must be at most ${options.max}`);
  }

  return value;
};

const parseStringArray = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ApiError(400, `${field} must be an array of strings`);
  }

  const parsed = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ApiError(400, `${field} must be an array of non-empty strings`);
    }

    return entry.trim();
  });

  return parsed;
};

const parseMemoryType = (value: unknown, field: string): MemoryType | undefined => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    return undefined;
  }

  if (!MEMORY_TYPES.has(parsed as MemoryType)) {
    throw new ApiError(400, `${field} must be a supported memory type`);
  }

  return parsed as MemoryType;
};

const parseMemorySource = (value: unknown, field: string): MemorySource | undefined => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    return undefined;
  }

  if (!MEMORY_SOURCES.has(parsed as MemorySource)) {
    throw new ApiError(400, `${field} must be a supported memory source`);
  }

  return parsed as MemorySource;
};

const parseWikiPageType = (value: unknown, field: string): WikiPageType | undefined => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    return undefined;
  }

  if (!WIKI_PAGE_TYPE_VALUES.has(parsed as WikiPageType)) {
    throw new ApiError(400, `${field} must be a supported wiki page type`);
  }

  return parsed as WikiPageType;
};

const parseWikiPageStatus = (value: unknown, field: string): WikiPageStatus | undefined => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    return undefined;
  }

  if (!WIKI_PAGE_STATUS_VALUES.has(parsed as WikiPageStatus)) {
    throw new ApiError(400, `${field} must be a supported wiki page status`);
  }

  return parsed as WikiPageStatus;
};

const parseIntegerString = (value: unknown, field: string): number | undefined => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    return undefined;
  }

  return parseNumber(Number.parseInt(parsed, 10), field, {
    integer: true,
    min: 1
  });
};

const parseDateString = (value: unknown, field: string): string | undefined => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    return undefined;
  }

  if (Number.isNaN(new Date(parsed).getTime())) {
    throw new ApiError(400, `${field} must be a valid date`);
  }

  return parsed;
};

const getRequestAuditContext = (req: Request): AuditContext => ({
  actor: "api",
  ip: req.ip ?? null
});

export function createRouter(services: APIRouterServices): Router {
  const router = Router();
  const analyticsService = new AnalyticsService(services.repository);
  const pageManager = new PageManager(services.repository);

  router.post(
    "/api/store",
    handleRoute(async (req, res) => {
      const body = requireBody(req.body);
      const result = await services.memoryService.store({
        content: requireString(body.content, "content"),
        type: parseMemoryType(body.type, "type") ?? (() => {
          throw new ApiError(400, "type is required");
        })(),
        project: parseSingleValue(body.project, "project") ?? "global",
        title: parseSingleValue(body.title, "title"),
        tags: parseStringArray(body.tags, "tags"),
        importance: parseNumber(body.importance, "importance", {
          min: 0,
          max: 1
        }),
        source: parseMemorySource(body.source, "source"),
        auditContext: getRequestAuditContext(req)
      });

      res.status(200).json(result);
    })
  );

  router.post(
    "/api/recall",
    handleRoute(async (req, res) => {
      const body = requireBody(req.body);
      const query = requireString(body.query, "query");
      const result = await services.recallService.recall(query, {
        project: parseSingleValue(body.project, "project"),
        type: parseMemoryType(body.type, "type"),
        limit:
          parseNumber(body.limit, "limit", {
            integer: true,
            min: 1
          }) ?? 5,
        minSimilarity:
          parseNumber(body.min_similarity ?? body.minSimilarity, "min_similarity", {
            min: 0,
            max: 1
          }) ?? 0.3
      });

      res.status(200).json(
        result.map(serializeSearchResult)
      );
    })
  );

  router.get("/api/recall/stream", (req, res) => {
    try {
      const query = requireString(req.query.query, "query");
      const options = {
        project: parseSingleValue(req.query.project, "project"),
        type: parseMemoryType(req.query.type, "type"),
        limit: parseIntegerString(req.query.limit, "limit") ?? 5,
        minSimilarity:
          parseNumber(
            Number.parseFloat(parseSingleValue(req.query.min_similarity, "min_similarity") ?? "0.3"),
            "min_similarity",
            {
              min: 0,
              max: 1
            }
          ) ?? 0.3
      };
      let closed = false;
      const markClosed = (): void => {
        closed = true;
      };

      req.on("close", markClosed);
      res.on("close", markClosed);

      res.status(200);
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders();
      flushResponse(res);

      void (async () => {
        try {
          for await (const result of services.recallService.recallStream(query, options)) {
            if (closed || res.writableEnded) {
              break;
            }

            writeSseEvent(res, serializeSearchResult(result));
          }

          if (!closed && !res.writableEnded) {
            writeSseEvent(res, { done: true }, "end");
            res.end();
          }
        } catch (error: unknown) {
          const { message } = getErrorResponse(error);

          if (!closed && !res.writableEnded) {
            writeSseEvent(res, { error: message }, "error");
            res.end();
          }
        } finally {
          req.off("close", markClosed);
          res.off("close", markClosed);
        }
      })();
    } catch (error: unknown) {
      const { status, message } = getErrorResponse(error);
      res.status(status).json({
        error: message
      });
    }
  });

  router.get(
    "/api/list",
    handleRoute((req, res) => {
      const memories = services.recallService.listMemories({
        project: parseSingleValue(req.query.project, "project"),
        type: parseMemoryType(req.query.type, "type"),
        limit: parseIntegerString(req.query.limit, "limit") ?? 20,
        sort: parseSingleValue(req.query.sort, "sort")
      });

      res.status(200).json(memories.map(serializeMemory));
    })
  );

  router.patch(
    "/api/memory/:id",
    handleRoute(async (req, res) => {
      const body = requireBody(req.body);
      const id = requireString(req.params.id, "id");

      await services.memoryService.update(
        id,
        {
          content: parseSingleValue(body.content, "content"),
          importance: parseNumber(body.importance, "importance", {
            min: 0,
            max: 1
          }),
          tags: parseStringArray(body.tags, "tags")
        },
        getRequestAuditContext(req)
      );

      res.status(200).json({
        id,
        action: "updated"
      });
    })
  );

  router.delete(
    "/api/memory/:id",
    handleRoute(async (req, res) => {
      const id = requireString(req.params.id, "id");
      await services.memoryService.delete(id, getRequestAuditContext(req));

      res.status(200).json({
        id,
        action: "deleted"
      });
    })
  );

  router.post(
    "/api/session/start",
    handleRoute(async (req, res) => {
      const body = requireBody(req.body);
      const result = await services.sessionService.sessionStart(
        requireString(body.working_directory, "working_directory"),
        parseSingleValue(body.task_hint, "task_hint")
      );

      res.status(200).json(serializeSessionStartResult(result));
    })
  );

  router.post(
    "/api/session/end",
    handleRoute(async (req, res) => {
      const body = requireBody(req.body);
      const project = requireString(body.project, "project");
      await services.sessionService.sessionEnd(
        project,
        requireString(body.summary, "summary"),
        parseStringArray(body.completed_tasks, "completed_tasks"),
        getRequestAuditContext(req)
      );

      res.status(200).json({
        project,
        action: "ended"
      });
    })
  );

  router.get(
    "/api/analytics",
    handleRoute((req, res) => {
      res.status(200).json(
        analyticsService.getUsageStats(
          parseSingleValue(req.query.tenant_id, "tenant_id"),
          parseDateString(req.query.since, "since")
        )
      );
    })
  );

  router.get(
    "/api/health",
    handleRoute(async (_req, res) => {
      res.status(200).json(await getHealthReport(services.repository, services.config));
    })
  );

  router.post(
    "/api/compact",
    handleRoute((req, res) => {
      const body = req.body === undefined ? {} : requireBody(req.body);
      const result = services.compactService.compact(
        parseSingleValue(body.project, "project"),
        getRequestAuditContext(req)
      );

      res.status(200).json(result);
    })
  );

  router.get(
    "/api/wiki/pages",
    handleRoute((req, res) => {
      const pages = pageManager.listPages({
        project: parseSingleValue(req.query.project, "project"),
        page_type: parseWikiPageType(req.query.page_type, "page_type"),
        status: parseWikiPageStatus(req.query.status, "status"),
        limit: parseIntegerString(req.query.limit, "limit") ?? 50
      });

      res.status(200).json(pages.map(serializeWikiPageListEntry));
    })
  );

  router.get(
    "/api/wiki/pages/:slug/versions",
    handleRoute((req, res) => {
      const slug = requireString(req.params.slug, "slug");
      const page = pageManager.getPage(slug);

      if (!page) {
        throw new ApiError(404, `Wiki page not found: ${slug}`);
      }

      res.status(200).json(pageManager.getVersions(page.id).map(serializeWikiPageVersion));
    })
  );

  router.get(
    "/api/wiki/pages/:slug",
    handleRoute((req, res) => {
      const slug = requireString(req.params.slug, "slug");
      const page = pageManager.getPageWithBacklinks(slug);

      if (!page) {
        throw new ApiError(404, `Wiki page not found: ${slug}`);
      }

      res.status(200).json(serializePageWithBacklinks(page));
    })
  );

  router.post(
    "/api/wiki/search",
    handleRoute((req, res) => {
      const body = requireBody(req.body);
      const query = requireString(body.query, "query");
      const results = searchWikiPages(services.repository, {
        query,
        project: parseSingleValue(body.project, "project"),
        limit:
          parseNumber(body.limit, "limit", {
            integer: true,
            min: 1
          }) ?? 10
      });

      res.status(200).json(results);
    })
  );

  return router;
}
