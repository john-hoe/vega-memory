import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Express, type RequestHandler, type Response } from "express";

import type { VegaConfig } from "../config.js";
import {
  DASHBOARD_AUTH_COOKIE,
  isAuthorizedRequest,
  matchesConfiguredApiKey
} from "../api/auth.js";
import { Repository } from "../db/repository.js";

const DASHBOARD_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'"
].join("; ");

const resolvePublicDir = (): string => {
  const sourceDir = resolve(process.cwd(), "src", "web", "public");

  if (existsSync(sourceDir)) {
    return sourceDir;
  }

  return join(dirname(fileURLToPath(import.meta.url)), "public");
};

const setDashboardHeaders = (res: Response): void => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", DASHBOARD_CSP);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
};

const renderLoginPage = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vega Memory Dashboard Login</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #081014;
        --panel: rgba(16, 25, 32, 0.94);
        --border: rgba(127, 180, 198, 0.18);
        --text: #edf4f7;
        --muted: #8ba0ac;
        --accent: #48c4b6;
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
        background: rgba(72, 196, 182, 0.14);
        color: var(--text);
        font: inherit;
        cursor: pointer;
      }

      .error {
        margin-bottom: 16px;
        color: var(--danger);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Vega Memory Dashboard</h1>
      <p>Enter the scheduler API key to access the dashboard and JSON API.</p>
      <form action="/dashboard/login" method="post">
        <label for="api-key">API Key</label>
        <input id="api-key" name="apiKey" type="password" autocomplete="current-password" required />
        <button type="submit">Unlock Dashboard</button>
      </form>
    </main>
  </body>
</html>`;

const requireDashboardAuth =
  (config: VegaConfig, sendLoginPage: boolean): RequestHandler =>
  (req, res, next) => {
    if (isAuthorizedRequest(req, config)) {
      next();
      return;
    }

    setDashboardHeaders(res);

    if (sendLoginPage) {
      res.status(401).type("html").send(renderLoginPage());
      return;
    }

    res.status(401).type("text/plain").send("unauthorized");
  };

export function mountDashboard(
  app: Express,
  _repository: Repository,
  config: VegaConfig
): void {
  const publicDir = resolvePublicDir();
  const dashboardAuth = requireDashboardAuth(config, true);
  const assetAuth = requireDashboardAuth(config, false);

  app.post("/dashboard/login", express.urlencoded({ extended: false }), (req, res) => {
    const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";

    if (
      config.apiKey === undefined ||
      !matchesConfiguredApiKey(apiKey, config.apiKey)
    ) {
      setDashboardHeaders(res);
      res.status(401).type("html").send(renderLoginPage());
      return;
    }

    res.cookie(DASHBOARD_AUTH_COOKIE, config.apiKey, {
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
      sameSite: "strict"
    });
    res.redirect("/");
  });

  app.post("/dashboard/logout", (_req, res) => {
    res.clearCookie(DASHBOARD_AUTH_COOKIE, {
      httpOnly: true,
      path: "/",
      sameSite: "strict"
    });
    res.redirect("/");
  });

  app.get("/", dashboardAuth, (_req, res) => {
    setDashboardHeaders(res);
    res.sendFile(join(publicDir, "index.html"));
  });
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
