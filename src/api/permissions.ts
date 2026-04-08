import type { Request, RequestHandler, Response } from "express";

import { getRequestTenantId, getRequestUser } from "./auth.js";
import type { User, UserRole } from "../core/user.js";

const FORBIDDEN_RESPONSE = {
  error: "forbidden"
} as const;

const getRequestedTenantId = (req: Request, res: Response): string | null => {
  const paramTenantId =
    typeof req.params.tenantId === "string" && req.params.tenantId.trim().length > 0
      ? req.params.tenantId.trim()
      : null;

  if (paramTenantId !== null) {
    return paramTenantId;
  }

  const queryTenantId =
    typeof req.query.tenant_id === "string" && req.query.tenant_id.trim().length > 0
      ? req.query.tenant_id.trim()
      : null;

  if (queryTenantId !== null) {
    return queryTenantId;
  }

  const body = req.body as Record<string, unknown> | undefined;
  const bodyTenantId =
    typeof body?.tenant_id === "string" && body.tenant_id.trim().length > 0
      ? body.tenant_id.trim()
      : null;

  return bodyTenantId ?? getRequestTenantId(res);
};

export const requireRole = (...roles: UserRole[]): RequestHandler => {
  const allowedRoles = new Set<UserRole>(roles);

  return (_req, res, next) => {
    const user = getRequestUser(res);
    const tenantId = getRequestTenantId(res);

    if (user === null) {
      if (tenantId !== null) {
        res.status(403).json(FORBIDDEN_RESPONSE);
        return;
      }

      next();
      return;
    }

    if (!allowedRoles.has(user.role)) {
      res.status(403).json(FORBIDDEN_RESPONSE);
      return;
    }

    next();
  };
};

export const requireTenantAccess = (): RequestHandler => {
  return (req, res, next) => {
    const user = getRequestUser(res);
    const requestedTenantId = getRequestedTenantId(req, res);

    if (user !== null && requestedTenantId !== null && user.tenant_id !== requestedTenantId) {
      res.status(403).json(FORBIDDEN_RESPONSE);
      return;
    }

    next();
  };
};
