import { createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";

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
  jwks_uri: string;
}

interface OidcClaims {
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  tenant_id?: unknown;
  tenant?: unknown;
  org?: unknown;
  tid?: unknown;
}

interface OidcJwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface OidcLoginState {
  createdAt: number;
  returnTo: string;
  tenantId?: string;
  nonce: string;
}

interface OidcJwk {
  kid?: string;
  alg?: string;
  use?: string;
  kty?: string;
  n?: string;
  e?: string;
}

interface VerifyIdTokenOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
  nonce?: string;
}

const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
const OIDC_JWKS_TTL_MS = 60 * 60 * 1000;
const OIDC_CLOCK_SKEW_SECONDS = 60;
const OIDC_MAX_TOKEN_AGE_SECONDS = 60 * 60;
const oidcStates = new WeakMap<VegaConfig, Map<string, OidcLoginState>>();
const oidcJwksCache = new Map<string, { expiresAt: number; keys: OidcJwk[] }>();

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
): { state: string; nonce: string } => {
  pruneStateStore(config);
  const state = randomBytes(24).toString("hex");
  const nonce = randomBytes(24).toString("hex");

  getStateStore(config).set(state, {
    createdAt: Date.now(),
    returnTo,
    nonce,
    ...(tenantId === undefined ? {} : { tenantId })
  });

  return {
    state,
    nonce
  };
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
    typeof document.token_endpoint !== "string" ||
    typeof document.jwks_uri !== "string"
  ) {
    throw new Error("OIDC discovery document is invalid");
  }

  return {
    issuer:
      typeof document.issuer === "string"
        ? document.issuer
        : oidcConfig.issuerUrl.replace(/\/+$/u, ""),
    authorization_endpoint: document.authorization_endpoint,
    token_endpoint: document.token_endpoint,
    jwks_uri: document.jwks_uri
  };
};

const decodeJwtPart = <T extends object>(part: string, label: string): T => {
  if (part.length === 0) {
    throw new Error(`OIDC JWT ${label} is missing`);
  }

  const normalized = part.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64").toString("utf8");
  const parsed = JSON.parse(decoded) as unknown;

  if (!isRecord(parsed)) {
    throw new Error(`OIDC JWT ${label} is invalid`);
  }

  return parsed as T;
};

const decodeJwtPayload = (jwt: string): OidcClaims => {
  const parts = jwt.split(".");

  if (parts.length < 2) {
    throw new Error("OIDC id_token is malformed");
  }

  return decodeJwtPart<OidcClaims>(parts[1] ?? "", "payload");
};

const decodeJwtHeader = (jwt: string): OidcJwtHeader => {
  const parts = jwt.split(".");

  if (parts.length !== 3) {
    throw new Error("OIDC id_token is malformed");
  }

  return decodeJwtPart<OidcJwtHeader>(parts[0] ?? "", "header");
};

const normalizeAudience = (audience: unknown): string[] => {
  if (typeof audience === "string") {
    return [audience];
  }

  if (Array.isArray(audience) && audience.every((entry) => typeof entry === "string")) {
    return audience;
  }

  return [];
};

const normalizeNumericClaim = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const getJwks = async (jwksUri: string): Promise<OidcJwk[]> => {
  const cached = oidcJwksCache.get(jwksUri);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.keys;
  }

  const response = await fetch(jwksUri, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`OIDC JWKS fetch failed with status ${response.status}`);
  }

  const document = (await response.json()) as unknown;

  if (!isRecord(document) || !Array.isArray(document.keys)) {
    throw new Error("OIDC JWKS response is invalid");
  }

  const keys = document.keys.filter((entry): entry is OidcJwk => isRecord(entry));
  oidcJwksCache.set(jwksUri, {
    expiresAt: now + OIDC_JWKS_TTL_MS,
    keys
  });

  return keys;
};

export const verifyIdToken = async (
  token: string,
  options: VerifyIdTokenOptions
): Promise<OidcClaims> => {
  const header = decodeJwtHeader(token);
  const claims = decodeJwtPayload(token);
  const parts = token.split(".");
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = parts[2];

  if (!signature) {
    throw new Error("OIDC id_token signature is missing");
  }

  if (header.alg !== "RS256") {
    throw new Error(`Unsupported OIDC id_token algorithm: ${String(header.alg ?? "unknown")}`);
  }

  if (typeof header.kid !== "string" || header.kid.trim().length === 0) {
    throw new Error("OIDC id_token header is missing kid");
  }

  const jwks = await getJwks(options.jwksUri);
  const jwk = jwks.find(
    (entry) =>
      entry.kid === header.kid &&
      entry.kty === "RSA" &&
      (entry.use === undefined || entry.use === "sig")
  );

  if (!jwk) {
    throw new Error(`OIDC JWKS key not found for kid ${header.kid}`);
  }

  const publicKey = createPublicKey({
    key: jwk as unknown as import("node:crypto").JsonWebKey,
    format: "jwk"
  });
  const isValidSignature = verifySignature(
    "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    publicKey,
    Buffer.from(signature.replace(/-/gu, "+").replace(/_/gu, "/"), "base64")
  );

  if (!isValidSignature) {
    throw new Error("OIDC id_token signature is invalid");
  }

  const issuer = normalizeOptionalString(claims.iss);
  if (issuer !== options.issuer) {
    throw new Error("OIDC id_token issuer is invalid");
  }

  const audiences = normalizeAudience(claims.aud);
  if (!audiences.includes(options.audience)) {
    throw new Error("OIDC id_token audience is invalid");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = normalizeNumericClaim(claims.exp);
  if (expiresAt === null || expiresAt <= nowSeconds - OIDC_CLOCK_SKEW_SECONDS) {
    throw new Error("OIDC id_token is expired");
  }

  const issuedAt = normalizeNumericClaim(claims.iat);
  if (issuedAt === null) {
    throw new Error("OIDC id_token is missing iat");
  }

  if (issuedAt > nowSeconds + OIDC_CLOCK_SKEW_SECONDS) {
    throw new Error("OIDC id_token iat is in the future");
  }

  if (nowSeconds - issuedAt > OIDC_MAX_TOKEN_AGE_SECONDS + OIDC_CLOCK_SKEW_SECONDS) {
    throw new Error("OIDC id_token iat is too old");
  }

  if (options.nonce !== undefined) {
    if (normalizeOptionalString(claims.nonce) !== options.nonce) {
      throw new Error("OIDC id_token nonce is invalid");
    }
  }

  return claims;
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
  normalizeOptionalString(claims.tenant) ??
  normalizeOptionalString(claims.org) ??
  normalizeOptionalString(claims.tenant_id) ??
  normalizeOptionalString(claims.tid);

export const resolveProvisioningTenantId = (
  repository: Repository,
  claims: OidcClaims,
  loginState: OidcLoginState
): string | null => {
  const explicitTenantId =
    normalizeOptionalString(loginState.tenantId) ?? getClaimTenantId(claims);

  if (explicitTenantId !== undefined) {
    return explicitTenantId;
  }

  const tenants = new TenantService(repository).listTenants();
  if (tenants.length === 1) {
    return tenants[0].id;
  }

  if (tenants.length > 1) {
    throw new Error(
      "Cannot determine tenant for OIDC user in multi-tenant deployment. Provide tenant context via login state or token claim."
    );
  }

  return null;
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

  if (tenantId === null) {
    throw new Error(
      "Cannot provision OIDC user because no tenant exists. Create a tenant first or provide tenant context via login state or token claim."
    );
  }

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

const redirectOidcError = (res: Response, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  const redirectUrl = new URL("/dashboard/login", "http://localhost");

  redirectUrl.searchParams.set("error", message);
  res.redirect(302, `${redirectUrl.pathname}${redirectUrl.search}`);
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
      const { state, nonce } = createLoginState(config, returnTo, tenantId);
      const redirectUrl = new URL(discovery.authorization_endpoint);

      redirectUrl.searchParams.set("response_type", "code");
      redirectUrl.searchParams.set("client_id", oidcConfig.clientId);
      redirectUrl.searchParams.set("redirect_uri", oidcConfig.callbackUrl);
      redirectUrl.searchParams.set("scope", "openid email profile");
      redirectUrl.searchParams.set("state", state);
      redirectUrl.searchParams.set("nonce", nonce);

      res.redirect(302, redirectUrl.toString());
    } catch (error) {
      redirectOidcError(res, error);
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
      const claims = await verifyIdToken(tokenResponse.id_token, {
        issuer: discovery.issuer,
        audience: oidcConfig.clientId,
        jwksUri: discovery.jwks_uri,
        nonce: loginState.nonce
      });
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
