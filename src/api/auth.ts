import { timingSafeEqual } from "node:crypto";

import type { Request, RequestHandler } from "express";

import type { VegaConfig } from "../config.js";

export const DASHBOARD_AUTH_COOKIE = "vega_dashboard_auth";

const UNAUTHORIZED_RESPONSE = {
  error: "unauthorized"
} as const;
const dashboardSessions = new WeakMap<VegaConfig, Set<string>>();

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

const getDashboardSessionStore = (config: VegaConfig): Set<string> => {
  const existingStore = dashboardSessions.get(config);
  if (existingStore) {
    return existingStore;
  }

  const nextStore = new Set<string>();
  dashboardSessions.set(config, nextStore);
  return nextStore;
};

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

export const registerDashboardSession = (config: VegaConfig, sessionToken: string): void => {
  getDashboardSessionStore(config).add(sessionToken);
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

export const hasDashboardSession = (
  config: VegaConfig,
  sessionToken: string | undefined
): boolean => {
  if (sessionToken === undefined) {
    return false;
  }

  return dashboardSessions.get(config)?.has(sessionToken) ?? false;
};

export const isAuthorizedBearerRequest = (req: Request, config: VegaConfig): boolean => {
  if (config.apiKey === undefined) {
    return true;
  }

  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const bearerToken = authorization.slice("Bearer ".length).trim();

    if (matchesConfiguredApiKey(bearerToken, config.apiKey)) {
      return true;
    }
  }

  return false;
};

export const isAuthorizedRequest = (req: Request, config: VegaConfig): boolean => {
  if (config.apiKey === undefined) {
    return true;
  }

  return (
    isAuthorizedBearerRequest(req, config) ||
    hasDashboardSession(config, getDashboardSessionToken(req))
  );
};

export const createAuthMiddleware = (config: VegaConfig): RequestHandler => {
  if (config.apiKey === undefined) {
    return (_req, _res, next) => {
      next();
    };
  }

  return (req, res, next) => {
    if (!req.path.startsWith("/api")) {
      next();
      return;
    }

    if (!isAuthorizedRequest(req, config)) {
      res.status(401).json(UNAUTHORIZED_RESPONSE);
      return;
    }

    next();
  };
};
