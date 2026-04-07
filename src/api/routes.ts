import { Router, type Request, type RequestHandler, type Response } from "express";

import type { VegaConfig } from "../config.js";
import { WebhookService } from "../integrations/webhooks.js";
import { getRequestTenantId, getRequestUser } from "./auth.js";
import { requireRole, requireTenantAccess } from "./permissions.js";
import { AnalyticsService } from "../core/analytics.js";
import { AuditService, buildAuditFiltersForQuery } from "../core/audit-service.js";
import { CompactService } from "../core/compact.js";
import { getHealthReport } from "../core/health.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { UserService, type User, isUserRole } from "../core/user.js";
import type {
  AuditContext,
  AuditEntry,
  AuditQueryFilters,
  Memory,
  MemorySource,
  MemoryType,
  SearchResult,
  SessionStartResult
} from "../core/types.js";
import { Repository } from "../db/repository.js";
import { CommentService, type WikiComment } from "../wiki/comments.js";
import { NotificationService, type WikiNotification } from "../wiki/notifications.js";
import { PageManager } from "../wiki/page-manager.js";
import { PagePermissionService } from "../wiki/permissions.js";
import { searchWikiPages } from "../wiki/search.js";
import { SpaceService } from "../wiki/spaces.js";
import {
  WIKI_PAGE_STATUSES,
  WIKI_PAGE_TYPES,
  type PageWithBacklinks,
  type WikiPage,
  type WikiPageStatus,
  type WikiPageType,
  type WikiPageVersion,
  WIKI_SPACE_VISIBILITIES,
  type WikiSpace,
  type WikiSpaceVisibility
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
const WIKI_SPACE_VISIBILITY_VALUES = new Set<WikiSpaceVisibility>(WIKI_SPACE_VISIBILITIES);

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

const serializeAuditEntry = (entry: AuditEntry) => ({
  id: entry.id,
  timestamp: entry.timestamp,
  actor: entry.actor,
  action: entry.action,
  memory_id: entry.memory_id,
  detail: entry.detail,
  ip: entry.ip,
  tenant_id: entry.tenant_id ?? null
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
  space_id: page.space_id,
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
  space_id: page.space_id,
  parent_id: page.parent_id,
  sort_order: page.sort_order,
  created_at: page.created_at,
  updated_at: page.updated_at,
  reviewed_at: page.reviewed_at,
  published_at: page.published_at
});

const serializeWikiSpace = (space: WikiSpace) => space;

const serializePageWithBacklinks = (result: PageWithBacklinks) => ({
  page: serializeWikiPage(result.page),
  backlinks: result.backlinks
});

const serializeWikiPageVersion = (version: WikiPageVersion) => version;
const serializeWikiComment = (comment: WikiComment) => comment;
const serializeWikiNotification = (notification: WikiNotification) => notification;

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

const requireRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new ApiError(400, `${field} must be a JSON object`);
  }

  return value;
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

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") {
    throw new ApiError(400, `${field} must be a boolean`);
  }

  return value;
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

const parseWikiSpaceVisibility = (
  value: unknown,
  field: string
): WikiSpaceVisibility | undefined => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    return undefined;
  }

  if (!WIKI_SPACE_VISIBILITY_VALUES.has(parsed as WikiSpaceVisibility)) {
    throw new ApiError(400, `${field} must be a supported wiki space visibility`);
  }

  return parsed as WikiSpaceVisibility;
};

const parsePagePermissionLevel = (
  value: unknown,
  field: string
): "read" | "write" | "admin" | undefined => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    return undefined;
  }

  if (parsed !== "read" && parsed !== "write" && parsed !== "admin") {
    throw new ApiError(400, `${field} must be one of read, write, admin`);
  }

  return parsed;
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

const parseNonNegativeIntegerString = (value: unknown, field: string): number | undefined => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    return undefined;
  }

  return parseNumber(Number.parseInt(parsed, 10), field, {
    integer: true,
    min: 0
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

const parseUserRole = (value: unknown, field: string) => {
  const parsed = parseSingleValue(value, field);
  if (parsed === undefined) {
    throw new ApiError(400, `${field} is required`);
  }

  if (!isUserRole(parsed)) {
    throw new ApiError(400, `${field} must be one of admin, member, viewer`);
  }

  return parsed;
};

const getRequestAuditContext = (req: Request, res: Response): AuditContext => ({
  actor: "api",
  ip: req.ip ?? null,
  tenant_id: getRequestTenantId(res)
});

const assertTenantAccess = (
  memory: Memory,
  requestTenantId: string | null
): void => {
  if (requestTenantId === null) {
    return;
  }

  if ((memory.tenant_id ?? null) !== requestTenantId) {
    throw new ApiError(403, "forbidden");
  }
};

const requireTenantId = (res: Response, candidate: unknown): string => {
  const tenantId = getRequestTenantId(res) ?? parseSingleValue(candidate, "tenant_id");

  if (tenantId === undefined) {
    throw new ApiError(400, "tenant_id is required");
  }

  return tenantId;
};

const assertSpaceAccess = (
  space: WikiSpace | null,
  tenantId: string,
  id: string
): WikiSpace => {
  if (!space) {
    throw new ApiError(404, `Wiki space not found: ${id}`);
  }

  if (space.tenant_id !== tenantId) {
    throw new ApiError(403, "forbidden");
  }

  return space;
};

const assertPageAccess = (page: WikiPage, res: Response, spaceService: SpaceService): void => {
  if (page.space_id === null) {
    return;
  }

  const tenantId = getRequestTenantId(res);
  if (tenantId !== null) {
    assertSpaceAccess(spaceService.getSpace(page.space_id), tenantId, page.space_id);
  }
};

const resolveActorUser = (
  candidate: unknown,
  res: Response,
  repository: Repository
): User => {
  const requestUser = getRequestUser(res);

  if (requestUser !== null) {
    return requestUser;
  }

  const userId = parseSingleValue(candidate, "user_id");
  if (userId === undefined) {
    throw new ApiError(401, "authenticated user or user_id is required");
  }

  const user = repository.getUser(userId);
  if (user === null) {
    throw new ApiError(404, `User not found: ${userId}`);
  }

  const tenantId = getRequestTenantId(res);
  if (tenantId !== null && user.tenant_id !== tenantId) {
    throw new ApiError(403, "forbidden");
  }

  return user;
};

const getScopedTenantId = (res: Response, candidate: unknown): string | null => {
  const requestTenantId = getRequestTenantId(res);
  if (requestTenantId !== null) {
    return requestTenantId;
  }

  return parseSingleValue(candidate, "tenant_id") ?? null;
};

const getAuditQueryFilters = (req: Request, res: Response): AuditQueryFilters => ({
  actor: parseSingleValue(req.query.actor, "actor"),
  action: parseSingleValue(req.query.action, "action"),
  memoryId: parseSingleValue(req.query.memory_id ?? req.query.memoryId, "memory_id"),
  since: parseDateString(req.query.since, "since"),
  until: parseDateString(req.query.until, "until"),
  tenantId: getRequestTenantId(res) ?? parseSingleValue(req.query.tenant_id, "tenant_id"),
  limit: parseIntegerString(req.query.limit, "limit"),
  offset: parseNonNegativeIntegerString(req.query.offset, "offset")
});

export function createRouter(services: APIRouterServices): Router {
  const router = Router();
  const analyticsService = new AnalyticsService(services.repository);
  const auditService = new AuditService(services.repository);
  const pageManager = new PageManager(services.repository);
  const userService = new UserService(services.repository);
  const commentService = new CommentService(services.repository);
  const notificationService = new NotificationService(services.repository);
  const spaceService = new SpaceService(services.repository);
  const pagePermissionService = new PagePermissionService(services.repository);
  const webhookService = new WebhookService(services.config.webhooks);

  router.use(requireTenantAccess());

  router.post(
    "/api/store",
    handleRoute(async (req, res) => {
      const body = requireBody(req.body);
      const tenantId = getRequestTenantId(res);
      const result = await services.memoryService.store({
        content: requireString(body.content, "content"),
        type: parseMemoryType(body.type, "type") ?? (() => {
          throw new ApiError(400, "type is required");
        })(),
        project: parseSingleValue(body.project, "project") ?? "global",
        tenant_id: tenantId,
        title: parseSingleValue(body.title, "title"),
        tags: parseStringArray(body.tags, "tags"),
        importance: parseNumber(body.importance, "importance", {
          min: 0,
          max: 1
        }),
        source: parseMemorySource(body.source, "source"),
        auditContext: getRequestAuditContext(req, res)
      });

      res.status(200).json(result);
    })
  );

  router.post(
    "/api/recall",
    handleRoute(async (req, res) => {
      const body = requireBody(req.body);
      const query = requireString(body.query, "query");
      const tenantId = getRequestTenantId(res);
      const result = await services.recallService.recall(query, {
        project: parseSingleValue(body.project, "project"),
        type: parseMemoryType(body.type, "type"),
        tenant_id: tenantId,
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
      const tenantId = getRequestTenantId(res);
      const options = {
        project: parseSingleValue(req.query.project, "project"),
        type: parseMemoryType(req.query.type, "type"),
        tenant_id: tenantId,
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
        tenant_id: getRequestTenantId(res),
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
      const tenantId = getRequestTenantId(res);
      const memory = services.repository.getMemory(id);

      if (memory !== null) {
        assertTenantAccess(memory, tenantId);
      }

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
        getRequestAuditContext(req, res)
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
      const tenantId = getRequestTenantId(res);
      const memory = services.repository.getMemory(id);

      if (memory !== null) {
        assertTenantAccess(memory, tenantId);
      }

      await services.memoryService.delete(id, getRequestAuditContext(req, res));

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
        getRequestAuditContext(req, res)
      );

      res.status(200).json({
        project,
        action: "ended"
      });
    })
  );

  router.get(
    "/api/analytics",
    requireRole("admin"),
    handleRoute((req, res) => {
      res.status(200).json(
        analyticsService.getUsageStats(
          getRequestTenantId(res) ?? undefined,
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
    requireRole("admin"),
    handleRoute((req, res) => {
      const body = req.body === undefined ? {} : requireBody(req.body);
      const result = services.compactService.compact(
        parseSingleValue(body.project, "project"),
        getRequestAuditContext(req, res)
      );

      res.status(200).json(result);
    })
  );

  router.get(
    "/api/admin/audit",
    requireRole("admin"),
    handleRoute((req, res) => {
      const filters = getAuditQueryFilters(req, res);

      res.status(200).json({
        total: auditService.count(filters),
        entries: auditService.query(filters).map(serializeAuditEntry)
      });
    })
  );

  router.get(
    "/api/admin/audit/stats",
    requireRole("admin"),
    handleRoute((req, res) => {
      const filters = getAuditQueryFilters(req, res);
      const { where, params } = buildAuditFiltersForQuery(filters);
      const actionRows = services.repository.db
        .prepare<unknown[], { name: string; total: number }>(
          `SELECT action AS name, COUNT(*) AS total
           FROM audit_log
           ${where}
           GROUP BY action
           ORDER BY total DESC, action ASC`
        )
        .all(...params);
      const actorRows = services.repository.db
        .prepare<unknown[], { name: string; total: number }>(
          `SELECT actor AS name, COUNT(*) AS total
           FROM audit_log
           ${where}
           GROUP BY actor
           ORDER BY total DESC, actor ASC`
        )
        .all(...params);

      res.status(200).json({
        total: auditService.count(filters),
        by_action: Object.fromEntries(actionRows.map((row) => [row.name, row.total])),
        by_actor: Object.fromEntries(actorRows.map((row) => [row.name, row.total]))
      });
    })
  );

  router.delete(
    "/api/admin/audit/purge",
    requireRole("admin"),
    handleRoute((req, res) => {
      const beforeValue =
        parseDateString(req.query.before, "before") ??
        parseDateString((isRecord(req.body) ? req.body.before : undefined), "before");

      if (beforeValue === undefined) {
        throw new ApiError(400, "before is required");
      }

      res.status(200).json({
        deleted: auditService.purge(new Date(beforeValue))
      });
    })
  );

  router.get(
    "/api/admin/users",
    requireRole("admin"),
    handleRoute((req, res) => {
      const tenantId = getScopedTenantId(res, req.query.tenant_id) ?? undefined;

      res.status(200).json(userService.listUsers(tenantId));
    })
  );

  router.patch(
    "/api/admin/users/:id/role",
    requireRole("admin"),
    handleRoute((req, res) => {
      const body = requireBody(req.body);
      const id = requireString(req.params.id, "id");
      const existingUser = services.repository.getUser(id);

      if (existingUser === null) {
        throw new ApiError(404, `User not found: ${id}`);
      }

      const tenantId = getRequestTenantId(res);
      if (tenantId !== null && existingUser.tenant_id !== tenantId) {
        throw new ApiError(403, "forbidden");
      }

      userService.updateUser(id, {
        role: parseUserRole(body.role, "role")
      });

      res.status(200).json(services.repository.getUser(id));
    })
  );

  router.post(
    "/api/webhooks",
    handleRoute((req, res) => {
      const body = requireBody(req.body);
      const secret = parseSingleValue(body.secret, "secret");
      const webhook = {
        url: requireString(body.url, "url"),
        events: parseStringArray(body.events, "events") ?? (() => {
          throw new ApiError(400, "events is required");
        })(),
        enabled: requireBoolean(body.enabled, "enabled"),
        ...(secret === undefined ? {} : { secret })
      };

      webhookService.registerWebhook(webhook);
      res.status(201).json(webhook);
    })
  );

  router.get(
    "/api/webhooks",
    handleRoute((_req, res) => {
      res.status(200).json(webhookService.listWebhooks());
    })
  );

  router.delete(
    "/api/webhooks/:url",
    handleRoute((req, res) => {
      const url = requireString(req.params.url, "url");

      webhookService.removeWebhook(url);
      res.status(200).json({
        url,
        action: "deleted"
      });
    })
  );

  router.post(
    "/api/webhooks/test",
    handleRoute(async (req, res) => {
      const body = req.body === undefined ? {} : requireBody(req.body);
      const event = parseSingleValue(body.event, "event") ?? "webhook.test";
      const data = body.data === undefined ? {} : requireRecord(body.data, "data");
      const result = await webhookService.emit(event, data);

      res.status(200).json({
        event,
        ...result
      });
    })
  );

  router.get(
    "/api/admin/dashboard",
    requireRole("admin"),
    handleRoute(async (req, res) => {
      const tenantId = getScopedTenantId(res, req.query.tenant_id);
      const totalUsers = userService.listUsers(tenantId ?? undefined).length;
      const totalMemories =
        services.repository.db
          .prepare<unknown[], { total: number }>(
            `SELECT COUNT(*) AS total
             FROM memories
             ${tenantId === null ? "" : "WHERE tenant_id IS ?"}`
          )
          .get(...(tenantId === null ? [] : [tenantId]))?.total ?? 0;
      const activeTenants =
        tenantId === null
          ? services.repository.db
              .prepare<[], { total: number }>(
                `SELECT COUNT(*) AS total
                 FROM tenants
                 WHERE active = 1`
              )
              .get()?.total ?? 0
          : services.repository.db
              .prepare<[string], { total: number }>(
                `SELECT COUNT(*) AS total
                 FROM tenants
                 WHERE active = 1 AND id = ?`
              )
              .get(tenantId)?.total ?? 0;
      const health = await getHealthReport(services.repository, services.config);
      const usage = analyticsService.getUsageStats(tenantId ?? undefined);
      const recentActivity = services.repository.getRecentPerformanceLogs(10);

      res.status(200).json({
        health,
        usage,
        recent_activity: recentActivity,
        total_users: totalUsers,
        total_memories: totalMemories,
        active_tenants: activeTenants,
        recent_audit_events: auditService.query({
          tenantId,
          limit: 10,
          offset: 0
        }).map(serializeAuditEntry)
      });
    })
  );

  router.post(
    "/api/wiki/spaces",
    handleRoute((req, res) => {
      const body = requireBody(req.body);
      const space = spaceService.createSpace(
        requireString(body.name, "name"),
        requireString(body.slug, "slug"),
        requireTenantId(res, body.tenant_id),
        parseWikiSpaceVisibility(body.visibility, "visibility")
      );

      res.status(201).json(serializeWikiSpace(space));
    })
  );

  router.get(
    "/api/wiki/spaces",
    handleRoute((req, res) => {
      const tenantId = requireTenantId(res, req.query.tenant_id);

      res.status(200).json(spaceService.listSpaces(tenantId).map(serializeWikiSpace));
    })
  );

  router.patch(
    "/api/wiki/spaces/:id",
    handleRoute((req, res) => {
      const body = requireBody(req.body);
      const id = requireString(req.params.id, "id");
      const tenantId = requireTenantId(res, body.tenant_id ?? req.query.tenant_id);

      assertSpaceAccess(spaceService.getSpace(id), tenantId, id);
      spaceService.updateSpace(id, {
        name: parseSingleValue(body.name, "name"),
        slug: parseSingleValue(body.slug, "slug"),
        visibility: parseWikiSpaceVisibility(body.visibility, "visibility")
      });

      res.status(200).json(serializeWikiSpace(assertSpaceAccess(spaceService.getSpace(id), tenantId, id)));
    })
  );

  router.get(
    "/api/wiki/spaces/:id/pages",
    handleRoute((req, res) => {
      const id = requireString(req.params.id, "id");
      const tenantId = requireTenantId(res, req.query.tenant_id);

      assertSpaceAccess(spaceService.getSpace(id), tenantId, id);
      const pages = pageManager.listPages({
        project: parseSingleValue(req.query.project, "project"),
        page_type: parseWikiPageType(req.query.page_type, "page_type"),
        status: parseWikiPageStatus(req.query.status, "status"),
        space_id: id,
        limit: parseIntegerString(req.query.limit, "limit") ?? 50
      });

      res.status(200).json(pages.map(serializeWikiPageListEntry));
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

  router.post(
    "/api/wiki/pages/:id/permissions",
    handleRoute((req, res) => {
      const body = requireBody(req.body);
      const pageId = requireString(req.params.id, "id");
      const level = parsePagePermissionLevel(body.level, "level") ?? (() => {
        throw new ApiError(400, "level is required");
      })();
      const userId = parseSingleValue(body.user_id, "user_id");
      const role = parseSingleValue(body.role, "role");
      const page = pageManager.getPage(pageId);

      if (!page) {
        throw new ApiError(404, `Wiki page not found: ${pageId}`);
      }

      if (page.space_id !== null) {
        const tenantId = getRequestTenantId(res);
        if (tenantId !== null) {
          assertSpaceAccess(spaceService.getSpace(page.space_id), tenantId, page.space_id);
        }
      }

      if ((userId === undefined && role === undefined) || (userId !== undefined && role !== undefined)) {
        throw new ApiError(400, "provide exactly one of user_id or role");
      }

      if (userId !== undefined) {
        pagePermissionService.setPermission(pageId, userId, level);
      } else {
        pagePermissionService.setRolePermission(pageId, role as string, level);
      }

      res.status(200).json({
        page_id: pageId,
        action: "updated",
        permissions: pagePermissionService.getPermissions(pageId)
      });
    })
  );

  router.post(
    "/api/wiki/pages/:id/comments",
    handleRoute((req, res) => {
      const body = requireBody(req.body);
      const pageId = requireString(req.params.id, "id");
      const page = pageManager.getPage(pageId);

      if (!page) {
        throw new ApiError(404, `Wiki page not found: ${pageId}`);
      }

      assertPageAccess(page, res, spaceService);
      const actor = resolveActorUser(body.user_id, res, services.repository);

      const comment = commentService.addComment(
        page.id,
        actor.id,
        requireString(body.content, "content"),
        parseSingleValue(body.parent_comment_id, "parent_comment_id")
      );

      res.status(201).json(serializeWikiComment(comment));
    })
  );

  router.get(
    "/api/wiki/pages/:id/comments",
    handleRoute((req, res) => {
      const pageId = requireString(req.params.id, "id");
      const page = pageManager.getPage(pageId);

      if (!page) {
        throw new ApiError(404, `Wiki page not found: ${pageId}`);
      }

      assertPageAccess(page, res, spaceService);

      res.status(200).json(
        commentService
          .getComments(page.id, {
            limit: parseIntegerString(req.query.limit, "limit"),
            sort: parseSingleValue(req.query.sort, "sort")
          })
          .map(serializeWikiComment)
      );
    })
  );

  router.patch(
    "/api/wiki/comments/:id",
    handleRoute((req, res) => {
      const body = requireBody(req.body);
      const commentId = requireString(req.params.id, "id");
      const actor = resolveActorUser(body.user_id, res, services.repository);
      const comment = commentService.updateComment(
        commentId,
        actor.id,
        requireString(body.content, "content")
      );

      res.status(200).json(serializeWikiComment(comment));
    })
  );

  router.delete(
    "/api/wiki/comments/:id",
    handleRoute((req, res) => {
      const body = req.body === undefined ? {} : requireBody(req.body);
      const commentId = requireString(req.params.id, "id");
      const actor = resolveActorUser(body.user_id ?? req.query.user_id, res, services.repository);

      commentService.deleteComment(commentId, actor.id);

      res.status(200).json({
        id: commentId,
        action: "deleted"
      });
    })
  );

  router.get(
    "/api/wiki/notifications",
    handleRoute((req, res) => {
      const actor = resolveActorUser(req.query.user_id, res, services.repository);

      res.status(200).json(
        notificationService.getUnread(actor.id).map(serializeWikiNotification)
      );
    })
  );

  router.post(
    "/api/wiki/notifications/read",
    handleRoute((req, res) => {
      const body = req.body === undefined ? {} : requireBody(req.body);
      const actor = resolveActorUser(body.user_id, res, services.repository);

      notificationService.markAllRead(actor.id);

      res.status(200).json({
        user_id: actor.id,
        action: "marked_all_read"
      });
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
