import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { WhiteLabelSettings } from "./types.js";

const DEFAULT_CONFIG_PATH = resolve(process.cwd(), "data", "whitelabel.json");
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeText = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;

const normalizeNullableText = (value: unknown): string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeHexColor = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (!HEX_COLOR_PATTERN.test(normalized)) {
    return fallback;
  }

  if (normalized.length === 4) {
    return `#${normalized
      .slice(1)
      .split("")
      .map((part) => `${part}${part}`)
      .join("")}`.toLowerCase();
  }

  return normalized.toLowerCase();
};

export class WhiteLabelConfig {
  constructor(private readonly configPath = DEFAULT_CONFIG_PATH) {}

  private normalizeSettings(value: unknown): WhiteLabelSettings {
    const defaults = this.getDefaults();

    if (!isRecord(value)) {
      return defaults;
    }

    return {
      brandName: normalizeText(value.brandName, defaults.brandName),
      logoUrl: normalizeNullableText(value.logoUrl),
      primaryColor: normalizeHexColor(value.primaryColor, defaults.primaryColor),
      dashboardTitle: normalizeText(value.dashboardTitle, defaults.dashboardTitle),
      footerText: normalizeText(value.footerText, defaults.footerText),
      customCss: normalizeNullableText(value.customCss)
    };
  }

  load(): WhiteLabelSettings {
    if (!existsSync(this.configPath)) {
      return this.getDefaults();
    }

    const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as unknown;
    return this.normalizeSettings(parsed);
  }

  save(settings: WhiteLabelSettings): void {
    mkdirSync(dirname(resolve(this.configPath)), { recursive: true });
    writeFileSync(
      this.configPath,
      `${JSON.stringify(this.normalizeSettings(settings), null, 2)}\n`,
      "utf8"
    );
  }

  getDefaults(): WhiteLabelSettings {
    return {
      brandName: "Vega Memory",
      logoUrl: null,
      primaryColor: "#48c4b6",
      dashboardTitle: "Vega Memory Dashboard",
      footerText: "Powered by Vega Memory System",
      customCss: null
    };
  }
}
