import type { RequestHandler } from "express";

import type { VegaConfig } from "../config.js";

const UNAUTHORIZED_RESPONSE = {
  error: "unauthorized"
} as const;

export const createAuthMiddleware = (config: VegaConfig): RequestHandler => {
  if (config.apiKey === undefined) {
    return (_req, _res, next) => {
      next();
    };
  }

  return (req, res, next) => {
    const authorization = req.get("authorization");
    const expected = `Bearer ${config.apiKey}`;

    if (authorization !== expected) {
      res.status(401).json(UNAUTHORIZED_RESPONSE);
      return;
    }

    next();
  };
};
