import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Express } from "express";

import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";

const resolvePublicDir = (): string => {
  const sourceDir = resolve(process.cwd(), "src", "web", "public");

  if (existsSync(sourceDir)) {
    return sourceDir;
  }

  return join(dirname(fileURLToPath(import.meta.url)), "public");
};

export function mountDashboard(
  app: Express,
  _repository: Repository,
  _config: VegaConfig
): void {
  const publicDir = resolvePublicDir();

  app.get("/", (_req, res) => {
    res.sendFile(join(publicDir, "index.html"));
  });
  app.use(express.static(publicDir, { index: false }));
}
