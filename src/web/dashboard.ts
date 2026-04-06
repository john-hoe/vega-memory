import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, {
  type CookieOptions,
  type Express,
  type Request,
  type RequestHandler,
  type Response
} from "express";

import type { VegaConfig } from "../config.js";
import {
  DASHBOARD_AUTH_COOKIE,
  DASHBOARD_SESSION_MAX_AGE_MS,
  getDashboardSessionToken,
  hasDashboardSession,
  isAuthorizedBearerRequest,
  registerDashboardSession,
  revokeDashboardSession,
  matchesConfiguredApiKey
} from "../api/auth.js";
import type { WhiteLabelSettings } from "../core/types.js";
import { WhiteLabelConfig } from "../core/whitelabel.js";
import { Repository } from "../db/repository.js";

const DASHBOARD_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: http: https:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'"
].join("; ");
const DEFAULT_PRIMARY_COLOR = "#48c4b6";

const resolvePublicDir = (): string => {
  const sourceDir = resolve(process.cwd(), "src", "web", "public");

  if (existsSync(sourceDir)) {
    return sourceDir;
  }

  return join(dirname(fileURLToPath(import.meta.url)), "public");
};

const isLocalHostname = (hostname: string): boolean => {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
};

const getDashboardCookieOptions = (
  req: Request,
  maxAge?: number
): CookieOptions => ({
  httpOnly: true,
  ...(maxAge === undefined ? {} : { maxAge }),
  path: "/",
  sameSite: "strict",
  secure: !isLocalHostname(req.hostname)
});

const setDashboardHeaders = (res: Response): void => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", DASHBOARD_CSP);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const escapeStyleContent = (value: string): string => value.replaceAll(/<\/style/giu, "<\\/style");

const normalizeHexColor = (value: string): string => {
  const normalized = value.trim();

  if (/^#[0-9a-f]{6}$/iu.test(normalized)) {
    return normalized.toLowerCase();
  }

  if (/^#[0-9a-f]{3}$/iu.test(normalized)) {
    return `#${normalized
      .slice(1)
      .split("")
      .map((part) => `${part}${part}`)
      .join("")}`.toLowerCase();
  }

  return DEFAULT_PRIMARY_COLOR;
};

const hexToRgba = (hex: string, alpha: number): string => {
  const normalized = normalizeHexColor(hex).slice(1);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
};

const getBrandInitials = (brandName: string): string => {
  const normalized = brandName.replace(/[^a-z0-9]/giu, "").slice(0, 2).toUpperCase();
  return normalized.length > 0 ? normalized : "VM";
};

const renderBrandMark = (settings: WhiteLabelSettings): string =>
  settings.logoUrl
    ? `<img class="brand-logo" src="${escapeHtml(settings.logoUrl)}" alt="${escapeHtml(settings.brandName)} logo" />`
    : `<div class="brand-mark" aria-hidden="true">${escapeHtml(getBrandInitials(settings.brandName))}</div>`;

const renderCustomCss = (settings: WhiteLabelSettings): string =>
  settings.customCss === null ? "" : `<style>${escapeStyleContent(settings.customCss)}</style>`;

export const renderDashboardPage = (template: string, settings: WhiteLabelSettings): string => {
  const primaryColor = normalizeHexColor(settings.primaryColor);
  const replacements = new Map<string, string>([
    ["__VEGA_BRAND_NAME_ATTR__", escapeHtml(settings.brandName)],
    ["__VEGA_FOOTER_TEXT_ATTR__", escapeHtml(settings.footerText)],
    ["__VEGA_PRIMARY_COLOR_SOFT__", hexToRgba(primaryColor, 0.14)],
    ["__VEGA_PRIMARY_COLOR__", primaryColor],
    ["__VEGA_DASHBOARD_TITLE__", escapeHtml(settings.dashboardTitle)],
    ["__VEGA_BRAND_NAME__", escapeHtml(settings.brandName)],
    ["__VEGA_FOOTER_TEXT__", escapeHtml(settings.footerText)],
    ["__VEGA_BRAND_MARK__", renderBrandMark(settings)],
    ["__VEGA_CUSTOM_CSS__", renderCustomCss(settings)]
  ]);

  return template.replace(/__VEGA_[A-Z_]+__/gu, (token) => replacements.get(token) ?? token);
};

const renderLoginPage = (settings: WhiteLabelSettings, errorMessage?: string): string => {
  const primaryColor = normalizeHexColor(settings.primaryColor);
  const accentSoft = hexToRgba(primaryColor, 0.14);
  const errorMarkup =
    errorMessage === undefined ? "" : `<div class="error">${escapeHtml(errorMessage)}</div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(settings.dashboardTitle)} Login</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #081014;
        --panel: rgba(16, 25, 32, 0.94);
        --border: rgba(127, 180, 198, 0.18);
        --text: #edf4f7;
        --muted: #8ba0ac;
        --accent: ${primaryColor};
        --accent-soft: ${accentSoft};
        --danger: #ff8574;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(72, 196, 182, 0.18), transparent 34%),
          linear-gradient(180deg, #081014 0%, #030608 100%);
        color: var(--text);
      }

      .card {
        width: min(420px, 100%);
        padding: 28px;
        border: 1px solid var(--border);
        border-radius: 22px;
        background: var(--panel);
      }

      .brand-row {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 14px;
      }

      .brand-logo,
      .brand-mark {
        width: 52px;
        height: 52px;
        border-radius: 16px;
      }

      .brand-logo {
        object-fit: cover;
        border: 1px solid var(--border);
      }

      .brand-mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--border);
        background: var(--accent-soft);
        color: var(--text);
        font-weight: 700;
        letter-spacing: 0.08em;
      }

      h1 {
        margin: 0 0 10px;
        font-size: 1.8rem;
        letter-spacing: -0.04em;
      }

      p {
        margin: 0 0 20px;
        color: var(--muted);
        line-height: 1.6;
      }

      label {
        display: block;
        margin-bottom: 8px;
        font-size: 0.95rem;
      }

      input {
        width: 100%;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: rgba(4, 11, 15, 0.9);
        color: var(--text);
        font: inherit;
      }

      button {
        width: 100%;
        margin-top: 16px;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: var(--accent-soft);
        color: var(--text);
        font: inherit;
        cursor: pointer;
      }

      .error {
        margin-bottom: 16px;
        color: var(--danger);
      }

      .footer {
        margin-top: 18px;
        color: var(--muted);
        font-size: 0.9rem;
      }
    </style>
    ${renderCustomCss(settings)}
  </head>
  <body>
    <main class="card">
      <div class="brand-row">
        ${renderBrandMark(settings)}
        <div>
          <h1>${escapeHtml(settings.dashboardTitle)}</h1>
          <p>Access ${escapeHtml(settings.brandName)} using the configured scheduler API key.</p>
        </div>
      </div>
      ${errorMarkup}
      <form action="/dashboard/login" method="post">
        <label for="api-key">API Key</label>
        <input id="api-key" name="apiKey" type="password" autocomplete="current-password" required />
        <button type="submit">Unlock Dashboard</button>
      </form>
      <div class="footer">${escapeHtml(settings.footerText)}</div>
    </main>
  </body>
</html>`;
};

const requireDashboardAuth =
  (config: VegaConfig, repository: Repository, sendLoginPage: boolean): RequestHandler =>
  (req, res, next) => {
    if (
      config.apiKey === undefined ||
      isAuthorizedBearerRequest(req, res, config, repository) ||
      hasDashboardSession(config, getDashboardSessionToken(req))
    ) {
      next();
      return;
    }

    setDashboardHeaders(res);

    if (sendLoginPage) {
      res.status(401).type("html").send(renderLoginPage(new WhiteLabelConfig().load()));
      return;
    }

    res.status(401).type("text/plain").send("unauthorized");
  };

export function mountDashboard(
  app: Express,
  repository: Repository,
  config: VegaConfig
): void {
  const publicDir = resolvePublicDir();
  const dashboardTemplate = readFileSync(join(publicDir, "index.html"), "utf8");
  const wikiTemplate = readFileSync(join(publicDir, "wiki.html"), "utf8");
  const whiteLabelConfig = new WhiteLabelConfig();
  const dashboardAuth = requireDashboardAuth(config, repository, true);
  const assetAuth = requireDashboardAuth(config, repository, false);
  const renderDashboard: RequestHandler = (_req, res) => {
    setDashboardHeaders(res);
    res.type("html").send(renderDashboardPage(dashboardTemplate, whiteLabelConfig.load()));
  };
  const renderWiki: RequestHandler = (_req, res) => {
    setDashboardHeaders(res);
    res.type("html").send(renderDashboardPage(wikiTemplate, whiteLabelConfig.load()));
  };

  app.post("/dashboard/login", express.urlencoded({ extended: false }), (req, res) => {
    const settings = whiteLabelConfig.load();
    const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";

    if (
      config.apiKey === undefined ||
      !matchesConfiguredApiKey(apiKey, config.apiKey)
    ) {
      setDashboardHeaders(res);
      res.status(401).type("html").send(renderLoginPage(settings, "Invalid API key."));
      return;
    }

    const sessionToken = randomBytes(32).toString("hex");

    registerDashboardSession(config, sessionToken);
    res.cookie(
      DASHBOARD_AUTH_COOKIE,
      sessionToken,
      getDashboardCookieOptions(req, DASHBOARD_SESSION_MAX_AGE_MS)
    );
    res.redirect("/");
  });

  app.post("/dashboard/logout", (req, res) => {
    revokeDashboardSession(config, getDashboardSessionToken(req));
    res.clearCookie(DASHBOARD_AUTH_COOKIE, getDashboardCookieOptions(req));
    res.redirect("/");
  });

  app.get("/", dashboardAuth, renderDashboard);
  app.get("/index.html", dashboardAuth, renderDashboard);
  app.get("/wiki", dashboardAuth, renderWiki);
  app.get("/wiki.html", dashboardAuth, renderWiki);
  app.use(
    assetAuth,
    express.static(publicDir, {
      index: false,
      setHeaders: (res) => {
        setDashboardHeaders(res);
      }
    })
  );
}
