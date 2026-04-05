import { timingSafeEqual } from "node:crypto";

import type { Request, RequestHandler } from "express";

import type { VegaConfig } from "../config.js";

export const DASHBOARD_AUTH_COOKIE = "vega_dashboard_auth";

const UNAUTHORIZED_RESPONSE = {
  error: "unauthorized"
} as const;

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

export const isAuthorizedRequest = (req: Request, config: VegaConfig): boolean => {
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

  const cookies = parseCookies(req.get("cookie"));
  return matchesConfiguredApiKey(cookies[DASHBOARD_AUTH_COOKIE], config.apiKey);
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
