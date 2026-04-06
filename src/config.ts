import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CloudBackupConfig {
  enabled: boolean;
  provider: "local-sync" | "s3";
  destDir: string;
}

export interface VegaConfig {
  dbPath: string;
  dbEncryption: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  tokenBudget: number;
  similarityThreshold: number;
  shardingEnabled: boolean;
  backupRetentionDays: number;
  observerEnabled: boolean;
  apiPort: number;
  apiKey: string | undefined;
  mode: "server" | "client";
  serverUrl: string | undefined;
  cacheDbPath: string;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  encryptionKey?: string;
  cloudBackup?: CloudBackupConfig;
}

export const DB_ENCRYPTION_KEY_MISSING_MESSAGE =
  "VEGA_DB_ENCRYPTION is enabled but no encryption key is configured. Run vega init-encryption first.";

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const expandHomePath = (value: string): string => {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }

  return value;
};

const parseMode = (value: string | undefined): VegaConfig["mode"] =>
  value === "client" ? "client" : "server";

const parseOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseOptionalBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const getConfigFilePath = (): string => join(homedir(), ".vega", "config.json");

const loadFileConfig = (): Partial<
  Pick<VegaConfig, "mode" | "serverUrl" | "apiKey" | "cacheDbPath" | "dbEncryption">
> => {
  try {
    const parsed = JSON.parse(readFileSync(getConfigFilePath(), "utf8")) as unknown;

    if (!isRecord(parsed)) {
      return {};
    }

    const mode = parseOptionalString(parsed.mode);

    return {
      mode: mode === undefined ? undefined : parseMode(mode),
      serverUrl: parseOptionalString(parsed.server),
      apiKey: parseOptionalString(parsed.api_key),
      cacheDbPath: parseOptionalString(parsed.cache_db),
      dbEncryption: parseOptionalBoolean(parsed.db_encryption ?? parsed.dbEncryption)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
};

const parseCloudBackup = (): CloudBackupConfig | undefined => {
  const destDir = process.env.VEGA_CLOUD_BACKUP_DIR;

  if (!destDir) {
    return undefined;
  }

  return {
    enabled: true,
    provider: "local-sync",
    destDir: expandHomePath(destDir)
  };
};

export const loadConfig = (): VegaConfig => {
  const fileConfig = loadFileConfig();
  const dbEncryption =
    process.env.VEGA_DB_ENCRYPTION === undefined
      ? fileConfig.dbEncryption ?? false
      : process.env.VEGA_DB_ENCRYPTION === "true";
  const encryptionKey = process.env.VEGA_ENCRYPTION_KEY || undefined;

  return {
    dbPath: expandHomePath(process.env.VEGA_DB_PATH ?? "./data/memory.db"),
    dbEncryption,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL ?? "bge-m3",
    tokenBudget: clamp(parseNumber(process.env.VEGA_TOKEN_BUDGET, 2000), 500, 10_000),
    similarityThreshold: clamp(parseNumber(process.env.VEGA_SIMILARITY_THRESHOLD, 0.85), 0, 1),
    shardingEnabled: parseBoolean(process.env.VEGA_SHARDING_ENABLED, false),
    backupRetentionDays: clamp(
      parseNumber(process.env.VEGA_BACKUP_RETENTION_DAYS, 7),
      1,
      365
    ),
    observerEnabled: parseBoolean(process.env.VEGA_OBSERVER_ENABLED, false),
    apiPort: parseNumber(process.env.VEGA_API_PORT, 3271),
    apiKey: process.env.VEGA_API_KEY || fileConfig.apiKey || undefined,
    mode: parseMode(process.env.VEGA_MODE ?? fileConfig.mode),
    serverUrl: process.env.VEGA_SERVER_URL || fileConfig.serverUrl || undefined,
    cacheDbPath: expandHomePath(
      process.env.VEGA_CACHE_DB ?? fileConfig.cacheDbPath ?? "~/.vega/cache.db"
    ),
    telegramBotToken: process.env.VEGA_TG_BOT_TOKEN || undefined,
    telegramChatId: process.env.VEGA_TG_CHAT_ID || undefined,
    ...(encryptionKey === undefined ? {} : { encryptionKey }),
    cloudBackup: parseCloudBackup()
  };
};

export const requireDatabaseEncryptionKey = (
  config: Pick<VegaConfig, "dbEncryption">,
  encryptionKey: string | null | undefined
): string | undefined => {
  if (config.dbEncryption && encryptionKey == null) {
    throw new Error(DB_ENCRYPTION_KEY_MISSING_MESSAGE);
  }

  return encryptionKey ?? undefined;
};
