import { timingSafeEqual } from "node:crypto";

import type { Request, RequestHandler, Response } from "express";

import type { VegaConfig } from "../config.js";
import { TenantService } from "../core/tenant.js";
import type { User } from "../core/user.js";
import { Repository } from "../db/repository.js";

export const DASHBOARD_AUTH_COOKIE = "vega_dashboard_auth";
export const DASHBOARD_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

const UNAUTHORIZED_RESPONSE = {
  error: "unauthorized"
} as const;
const DASHBOARD_SESSION_PRUNE_INTERVAL_MS = 60 * 1000;
interface DashboardSession {
  issuedAt: number;
  user: User | null;
}

const dashboardSessions = new WeakMap<VegaConfig, Map<string, DashboardSession>>();
const dashboardSessionPruneTimes = new WeakMap<VegaConfig, number>();

const parseCookies = (cookieHeader: string | undefined): Record<string, string> => {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .reduce<Record<string, string>>((cookies, entry) => {
      const separatorIndex = entry.indexOf("=");

      if (separatorIndex <= 0) {
        return cookies;
      }

      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();

      if (key.length === 0) {
        return cookies;
      }

      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
      return cookies;
    }, {});
};

const clearRequestAuth = (res: Response): void => {
  delete res.locals.tenantId;
  delete res.locals.user;
};

const setRequestUser = (res: Response, user: User | null): void => {
  if (user === null) {
    delete res.locals.user;
    return;
  }

  res.locals.user = user;
};

const getDashboardSessionStore = (config: VegaConfig): Map<string, DashboardSession> => {
  const existingStore = dashboardSessions.get(config);
  if (existingStore) {
    return existingStore;
  }

  const nextStore = new Map<string, DashboardSession>();
  dashboardSessions.set(config, nextStore);
  return nextStore;
};

const setRequestTenantId = (res: Response, tenantId: string | null): void => {
  if (tenantId === null) {
    delete res.locals.tenantId;
    return;
  }

  res.locals.tenantId = tenantId;
};

const getTenantService = (repository?: Repository): TenantService | null =>
  repository ? new TenantService(repository) : null;

export const matchesConfiguredApiKey = (
  candidate: string | undefined,
  expected: string
): boolean => {
  if (candidate === undefined) {
    return false;
  }

  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
};

export const getDashboardSessionToken = (req: Request): string | undefined => {
  const cookies = parseCookies(req.get("cookie"));
  return cookies[DASHBOARD_AUTH_COOKIE];
};

export const registerDashboardSession = (
  config: VegaConfig,
  sessionToken: string,
  user?: User
): void => {
  getDashboardSessionStore(config).set(sessionToken, {
    issuedAt: Date.now(),
    user: user ?? null
  });
};

export const revokeDashboardSession = (
  config: VegaConfig,
  sessionToken: string | undefined
): void => {
  if (sessionToken === undefined) {
    return;
  }

  dashboardSessions.get(config)?.delete(sessionToken);
};

export const pruneStaleSessions = (config: VegaConfig, now = Date.now()): void => {
  const store = dashboardSessions.get(config);
  if (!store) {
    dashboardSessionPruneTimes.set(config, now);
    return;
  }

  for (const [sessionToken, session] of store) {
    if (now - session.issuedAt > DASHBOARD_SESSION_MAX_AGE_MS) {
      store.delete(sessionToken);
    }
  }

  dashboardSessionPruneTimes.set(config, now);
};

export const hasDashboardSession = (
  config: VegaConfig,
  sessionToken: string | undefined,
  now = Date.now()
): boolean => {
  return getDashboardSession(config, sessionToken, now) !== null;
};

export const getDashboardSession = (
  config: VegaConfig,
  sessionToken: string | undefined,
  now = Date.now()
): DashboardSession | null => {
  if (sessionToken === undefined) {
    return null;
  }

  const lastPrunedAt = dashboardSessionPruneTimes.get(config) ?? 0;
  if (now - lastPrunedAt >= DASHBOARD_SESSION_PRUNE_INTERVAL_MS) {
    pruneStaleSessions(config, now);
  }

  const session = dashboardSessions.get(config)?.get(sessionToken);
  if (session === undefined) {
    return null;
  }

  if (now - session.issuedAt > DASHBOARD_SESSION_MAX_AGE_MS) {
    dashboardSessions.get(config)?.delete(sessionToken);
    return null;
  }

  return session;
};

export const getRequestTenantId = (res: Response): string | null => {
  const tenantId = res.locals.tenantId;
  return typeof tenantId === "string" && tenantId.length > 0 ? tenantId : null;
};

export const getRequestUser = (res: Response): User | null => {
  const user = res.locals.user;
  return typeof user === "object" && user !== null ? (user as User) : null;
};

export const isAuthorizedBearerRequest = (
  req: Request,
  res: Response,
  config: VegaConfig,
  repository?: Repository
): boolean => {
  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const bearerToken = authorization.slice("Bearer ".length).trim();

    if (config.apiKey !== undefined && matchesConfiguredApiKey(bearerToken, config.apiKey)) {
      setRequestUser(res, null);
      setRequestTenantId(res, null);
      return true;
    }

    const tenant = getTenantService(repository)?.getTenantByApiKey(bearerToken) ?? null;
    if (tenant !== null) {
      setRequestUser(res, null);
      setRequestTenantId(res, tenant.id);
      return true;
    }
  }

  setRequestUser(res, null);
  setRequestTenantId(res, null);

  if (config.apiKey === undefined) {
    return true;
  }

  return false;
};

export const isAuthorizedRequest = (
  req: Request,
  res: Response,
  config: VegaConfig,
  repository?: Repository
): boolean => {
  return (
    isAuthorizedBearerRequest(req, res, config, repository) ||
    hasDashboardSession(config, getDashboardSessionToken(req))
  );
};

export const createAuthMiddleware = (config: VegaConfig, repository?: Repository): RequestHandler => {
  return (req, res, next) => {
    if (!req.path.startsWith("/api")) {
      next();
      return;
    }

    clearRequestAuth(res);

    const hasBearerToken = req.get("authorization")?.startsWith("Bearer ") ?? false;
    const bearerAuthorized = isAuthorizedBearerRequest(req, res, config, repository);
    const session = getDashboardSession(config, getDashboardSessionToken(req));

    if (session !== null && (!hasBearerToken || !bearerAuthorized)) {
      setRequestUser(res, session.user);
      setRequestTenantId(res, session.user?.tenant_id ?? null);
    }

    if (config.apiKey !== undefined && !bearerAuthorized && session === null) {
      res.status(401).json(UNAUTHORIZED_RESPONSE);
      return;
    }

    next();
  };
};
