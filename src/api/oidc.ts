import { randomBytes } from "node:crypto";

import { Router, type CookieOptions, type Request, type Response } from "express";

import type { VegaConfig } from "../config.js";
import { TenantService } from "../core/tenant.js";
import { UserService, type User } from "../core/user.js";
import { registerDashboardSession, DASHBOARD_AUTH_COOKIE, DASHBOARD_SESSION_MAX_AGE_MS } from "./auth.js";
import { Repository } from "../db/repository.js";

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

interface OidcClaims {
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  iss?: unknown;
  tenant_id?: unknown;
  tenant?: unknown;
  tid?: unknown;
}

interface OidcLoginState {
  createdAt: number;
  returnTo: string;
  tenantId?: string;
}

const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
const oidcStates = new WeakMap<VegaConfig, Map<string, OidcLoginState>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
};

const normalizeReturnTo = (value: unknown): string => {
  const normalized = normalizeOptionalString(value);

  if (normalized === undefined || !normalized.startsWith("/")) {
    return "/";
  }

  return normalized;
};

const getOidcConfig = (config: VegaConfig): OidcConfig | null => {
  if (
    config.oidcIssuerUrl === undefined ||
    config.oidcClientId === undefined ||
    config.oidcClientSecret === undefined ||
    config.oidcCallbackUrl === undefined
  ) {
    return null;
  }

  return {
    issuerUrl: config.oidcIssuerUrl,
    clientId: config.oidcClientId,
    clientSecret: config.oidcClientSecret,
    callbackUrl: config.oidcCallbackUrl
  };
};

const getStateStore = (config: VegaConfig): Map<string, OidcLoginState> => {
  const existingStore = oidcStates.get(config);
  if (existingStore) {
    return existingStore;
  }

  const nextStore = new Map<string, OidcLoginState>();
  oidcStates.set(config, nextStore);
  return nextStore;
};

const pruneStateStore = (config: VegaConfig, now = Date.now()): void => {
  const store = oidcStates.get(config);

  if (!store) {
    return;
  }

  for (const [state, loginState] of store) {
    if (now - loginState.createdAt > OIDC_STATE_TTL_MS) {
      store.delete(state);
    }
  }
};

const consumeLoginState = (config: VegaConfig, state: string): OidcLoginState | null => {
  pruneStateStore(config);
  const store = getStateStore(config);
  const loginState = store.get(state) ?? null;

  if (loginState === null) {
    return null;
  }

  store.delete(state);
  return loginState;
};

const createLoginState = (
  config: VegaConfig,
  returnTo: string,
  tenantId?: string
): string => {
  pruneStateStore(config);
  const state = randomBytes(24).toString("hex");

  getStateStore(config).set(state, {
    createdAt: Date.now(),
    returnTo,
    ...(tenantId === undefined ? {} : { tenantId })
  });

  return state;
};

const getDiscoveryUrl = (issuerUrl: string): string =>
  `${issuerUrl.replace(/\/+$/u, "")}/.well-known/openid-configuration`;

const fetchDiscoveryDocument = async (oidcConfig: OidcConfig): Promise<OidcDiscoveryDocument> => {
  const response = await fetch(getDiscoveryUrl(oidcConfig.issuerUrl), {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`OIDC discovery failed with status ${response.status}`);
  }

  const document = (await response.json()) as unknown;

  if (
    !isRecord(document) ||
    typeof document.authorization_endpoint !== "string" ||
    typeof document.token_endpoint !== "string"
  ) {
    throw new Error("OIDC discovery document is invalid");
  }

  return {
    issuer:
      typeof document.issuer === "string"
        ? document.issuer
        : oidcConfig.issuerUrl.replace(/\/+$/u, ""),
    authorization_endpoint: document.authorization_endpoint,
    token_endpoint: document.token_endpoint
  };
};

const decodeJwtPayload = (jwt: string): OidcClaims => {
  const parts = jwt.split(".");

  if (parts.length < 2) {
    throw new Error("OIDC id_token is malformed");
  }

  const payload = parts[1];
  if (!payload) {
    throw new Error("OIDC id_token payload is missing");
  }

  const normalized = payload.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64").toString("utf8");
  const claims = JSON.parse(decoded) as unknown;

  if (!isRecord(claims)) {
    throw new Error("OIDC id_token payload is invalid");
  }

  return claims as OidcClaims;
};

const exchangeAuthorizationCode = async (
  oidcConfig: OidcConfig,
  discovery: OidcDiscoveryDocument,
  code: string
): Promise<{ id_token: string }> => {
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: oidcConfig.callbackUrl,
      client_id: oidcConfig.clientId,
      client_secret: oidcConfig.clientSecret
    })
  });

  if (!response.ok) {
    throw new Error(`OIDC token exchange failed with status ${response.status}`);
  }

  const payload = (await response.json()) as unknown;

  if (!isRecord(payload) || typeof payload.id_token !== "string") {
    throw new Error("OIDC token response did not include id_token");
  }

  return {
    id_token: payload.id_token
  };
};

const getSessionCookieOptions = (req: Request, maxAge = DASHBOARD_SESSION_MAX_AGE_MS): CookieOptions => ({
  httpOnly: true,
  sameSite: "strict",
  secure: req.hostname !== "localhost" && req.hostname !== "127.0.0.1",
  path: "/",
  maxAge
});

const getClaimTenantId = (claims: OidcClaims): string | undefined =>
  normalizeOptionalString(claims.tenant_id) ??
  normalizeOptionalString(claims.tenant) ??
  normalizeOptionalString(claims.tid);

const resolveProvisioningTenantId = (
  repository: Repository,
  claims: OidcClaims,
  loginState: OidcLoginState
): string => {
  const explicitTenantId = loginState.tenantId ?? getClaimTenantId(claims);

  if (explicitTenantId !== undefined) {
    return explicitTenantId;
  }

  const tenants = new TenantService(repository).listTenants();
  if (tenants.length === 1) {
    return tenants[0].id;
  }

  return "default";
};

const upsertOidcUser = (
  repository: Repository,
  provider: string,
  claims: OidcClaims,
  loginState: OidcLoginState
): User => {
  const userService = new UserService(repository);
  const subject = normalizeOptionalString(claims.sub);

  if (subject === undefined) {
    throw new Error("OIDC id_token payload is missing sub");
  }

  const existingBySubject = userService.getUserBySsoSubject(provider, subject);
  const email = normalizeOptionalString(claims.email) ?? existingBySubject?.email;

  if (email === undefined) {
    throw new Error("OIDC id_token payload is missing email");
  }

  const name = normalizeOptionalString(claims.name) ?? existingBySubject?.name ?? email;

  if (existingBySubject !== null) {
    userService.updateUser(existingBySubject.id, {
      email,
      name,
      sso_provider: provider,
      sso_subject: subject
    });

    return userService.getUserBySsoSubject(provider, subject) ?? existingBySubject;
  }

  const existingByEmail = userService.getUserByEmail(email);

  if (existingByEmail !== null) {
    userService.updateUser(existingByEmail.id, {
      name,
      sso_provider: provider,
      sso_subject: subject
    });

    return userService.getUserBySsoSubject(provider, subject) ?? existingByEmail;
  }

  const tenantId = resolveProvisioningTenantId(repository, claims, loginState);
  const createdUser = userService.createUser(email, name, "member", tenantId);

  userService.updateUser(createdUser.id, {
    sso_provider: provider,
    sso_subject: subject
  });

  return userService.getUserBySsoSubject(provider, subject) ?? {
    ...createdUser,
    sso_provider: provider,
    sso_subject: subject
  };
};

const handleOidcError = (res: Response, error: unknown): void => {
  res.status(400).json({
    error: error instanceof Error ? error.message : String(error)
  });
};

export const createOidcRouter = (config: VegaConfig, repository: Repository): Router => {
  const router = Router();

  router.get("/api/auth/oidc/login", async (req, res) => {
    try {
      const oidcConfig = getOidcConfig(config);

      if (oidcConfig === null) {
        res.status(503).json({
          error: "oidc is not configured"
        });
        return;
      }

      const discovery = await fetchDiscoveryDocument(oidcConfig);
      const returnTo = normalizeReturnTo(req.query.return_to);
      const tenantId = normalizeOptionalString(req.query.tenant_id);
      const state = createLoginState(config, returnTo, tenantId);
      const redirectUrl = new URL(discovery.authorization_endpoint);

      redirectUrl.searchParams.set("response_type", "code");
      redirectUrl.searchParams.set("client_id", oidcConfig.clientId);
      redirectUrl.searchParams.set("redirect_uri", oidcConfig.callbackUrl);
      redirectUrl.searchParams.set("scope", "openid email profile");
      redirectUrl.searchParams.set("state", state);

      res.redirect(302, redirectUrl.toString());
    } catch (error) {
      handleOidcError(res, error);
    }
  });

  router.get("/api/auth/oidc/callback", async (req, res) => {
    try {
      const oidcConfig = getOidcConfig(config);

      if (oidcConfig === null) {
        res.status(503).json({
          error: "oidc is not configured"
        });
        return;
      }

      const code = normalizeOptionalString(req.query.code);
      const state = normalizeOptionalString(req.query.state);

      if (code === undefined || state === undefined) {
        throw new Error("OIDC callback requires code and state");
      }

      const loginState = consumeLoginState(config, state);

      if (loginState === null) {
        throw new Error("OIDC state is invalid or expired");
      }

      const discovery = await fetchDiscoveryDocument(oidcConfig);
      const tokenResponse = await exchangeAuthorizationCode(oidcConfig, discovery, code);
      const claims = decodeJwtPayload(tokenResponse.id_token);
      const provider = normalizeOptionalString(claims.iss) ?? discovery.issuer;
      const user = upsertOidcUser(repository, provider, claims, loginState);
      const sessionToken = randomBytes(32).toString("hex");

      registerDashboardSession(config, sessionToken, user);
      res.cookie(
        DASHBOARD_AUTH_COOKIE,
        sessionToken,
        getSessionCookieOptions(req)
      );
      res.redirect(302, loginState.returnTo);
    } catch (error) {
      handleOidcError(res, error);
    }
  });

  return router;
};
