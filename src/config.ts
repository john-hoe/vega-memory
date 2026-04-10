import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { RedactionPattern } from "./core/types.js";
import type { WebhookConfig } from "./integrations/webhooks.js";

export interface LocalSyncCloudBackupConfig {
  enabled: boolean;
  provider: "local-sync";
  destDir: string;
}

export interface S3CloudBackupConfig {
  enabled: boolean;
  provider: "s3";
  bucket: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface GDriveCloudBackupConfig {
  enabled: boolean;
  provider: "gdrive";
  folderId?: string;
  credentialsPath?: string;
}

export interface ICloudCloudBackupConfig {
  enabled: boolean;
  provider: "icloud";
  containerPath?: string;
}

export type CloudBackupConfig =
  | LocalSyncCloudBackupConfig
  | S3CloudBackupConfig
  | GDriveCloudBackupConfig
  | ICloudCloudBackupConfig;

export interface RegressionGuardConfig {
  maxSessionStartToken: number;
  maxRecallLatencyMs: number;
  minRecallAvgSimilarity: number;
  maxTopKInflationRatio: number;
}

export interface VegaFeatureFlags {
  factClaims: boolean;
  rawArchive: boolean;
  topicRecall: boolean;
  deepRecall: boolean;
  codeGraph: boolean;
  consolidationReport: boolean;
  consolidationAutoExecute: boolean;
}

export interface VegaConfig {
  dbPath: string;
  dbEncryption: boolean;
  consolidationCronEnabled?: boolean;
  consolidationCronIntervalMs?: number;
  sessionIncludeGraphReport?: boolean;
  archivePreserveRaw?: boolean;
  byokEnabled?: boolean;
  csrfEnabled?: boolean;
  corsOrigins?: string[];
  databaseType?: "sqlite" | "postgres";
  metricsEnabled?: boolean;
  sentryDsn?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
  logFormat?: "json" | "text";
  embeddingProvider?: "ollama" | "openai" | "azure-openai" | "bedrock";
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiEmbeddingModel?: string;
  azureOpenaiApiKey?: string;
  azureOpenaiBaseUrl?: string;
  azureOpenaiApiVersion?: string;
  azureOpenaiChatDeployment?: string;
  azureOpenaiEmbeddingDeployment?: string;
  bedrockRegion?: string;
  bedrockChatModel?: string;
  bedrockEmbeddingModel?: string;
  tokenBudget: number;
  similarityThreshold: number;
  shardingEnabled: boolean;
  backupRetentionDays: number;
  archiveMaxSizeMb?: number;
  observerEnabled: boolean;
  apiPort: number;
  apiKey: string | undefined;
  mode: "server" | "client";
  serverUrl: string | undefined;
  cacheDbPath: string;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  slackWebhookUrl?: string;
  slackBotToken?: string;
  slackChannel?: string;
  slackEnabled?: boolean;
  openclawUrl?: string;
  openclawKey?: string;
  openclawEnabled?: boolean;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePublishableKey?: string;
  stripeEnabled?: boolean;
  oidcIssuerUrl?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcCallbackUrl?: string;
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisDb?: number;
  redisEnabled?: boolean;
  queueEnabled?: boolean;
  queueRedisUrl?: string;
  queueConcurrency?: number;
  pgHost?: string;
  pgPort?: number;
  pgDatabase?: string;
  pgUser?: string;
  pgPassword?: string;
  pgSsl?: boolean;
  pgSchema?: string;
  encryptionKey?: string;
  cloudBackup?: CloudBackupConfig;
  regressionGuard?: RegressionGuardConfig;
  features?: Partial<VegaFeatureFlags>;
  customRedactionPatterns?: RedactionPattern[];
  webhooks?: WebhookConfig[];
}

export const DB_ENCRYPTION_KEY_MISSING_MESSAGE =
  "VEGA_DB_ENCRYPTION is enabled but no encryption key is configured. Run vega init-encryption first.";

export const DEFAULT_FEATURE_FLAGS: VegaFeatureFlags = {
  factClaims: false,
  rawArchive: true,
  topicRecall: false,
  deepRecall: true,
  codeGraph: false,
  consolidationReport: false,
  consolidationAutoExecute: false
};

export const resolveFeatureFlags = (
  config?: Pick<VegaConfig, "features">
): VegaFeatureFlags => ({
  ...DEFAULT_FEATURE_FLAGS,
  ...(config?.features ?? {})
});

export const isFactClaimsEnabled = (config?: Pick<VegaConfig, "features">): boolean =>
  resolveFeatureFlags(config).factClaims;

export const isRawArchiveEnabled = (config?: Pick<VegaConfig, "features">): boolean =>
  resolveFeatureFlags(config).rawArchive;

export const shouldPreserveRawArchive = (
  config?: Pick<VegaConfig, "archivePreserveRaw">
): boolean => config?.archivePreserveRaw ?? false;

export const isTopicRecallEnabled = (config?: Pick<VegaConfig, "features">): boolean =>
  resolveFeatureFlags(config).topicRecall;

export const isDeepRecallEnabled = (config?: Pick<VegaConfig, "features">): boolean =>
  resolveFeatureFlags(config).deepRecall;

export const isDeepRecallAvailable = (config?: Pick<VegaConfig, "features">): boolean => {
  const features = resolveFeatureFlags(config);

  return features.rawArchive && features.deepRecall;
};

export const isCodeGraphEnabled = (config?: Pick<VegaConfig, "features">): boolean =>
  resolveFeatureFlags(config).codeGraph;

export const isConsolidationReportEnabled = (config?: Pick<VegaConfig, "features">): boolean =>
  resolveFeatureFlags(config).consolidationReport;

export const isConsolidationAutoExecuteEnabled = (
  config?: Pick<VegaConfig, "features">
): boolean => resolveFeatureFlags(config).consolidationAutoExecute;

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseOptionalNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

const parseDatabaseType = (value: string | undefined): VegaConfig["databaseType"] =>
  value === "postgres" ? "postgres" : "sqlite";

const parseLogLevel = (value: string | undefined): NonNullable<VegaConfig["logLevel"]> => {
  switch (value) {
    case "debug":
    case "warn":
    case "error":
      return value;
    default:
      return "info";
  }
};

const parseLogFormat = (value: string | undefined): NonNullable<VegaConfig["logFormat"]> =>
  value === "text" ? "text" : "json";

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

const parseCustomRedactionPatterns = (value: unknown): RedactionPattern[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.pattern !== "string") {
      return [];
    }

    const name = entry.name.trim();
    const pattern = entry.pattern.trim();

    if (name.length === 0 || pattern.length === 0) {
      return [];
    }

    const replacement = parseOptionalString(entry.replacement);
    const enabled = parseOptionalBoolean(entry.enabled);

    return [
      {
        name,
        pattern,
        ...(replacement === undefined ? {} : { replacement }),
        ...(enabled === undefined ? {} : { enabled })
      }
    ];
  });
};

const parseWebhookConfig = (value: unknown): WebhookConfig => {
  if (!isRecord(value)) {
    throw new Error("VEGA_WEBHOOKS entries must be objects");
  }

  const url = parseOptionalString(value.url);

  if (url === undefined) {
    throw new Error("VEGA_WEBHOOKS entries must include a non-empty url");
  }

  if (!Array.isArray(value.events) || value.events.some((event) => typeof event !== "string")) {
    throw new Error("VEGA_WEBHOOKS entries must include an events string array");
  }

  const enabled = parseOptionalBoolean(value.enabled);

  if (enabled === undefined) {
    throw new Error("VEGA_WEBHOOKS entries must include an enabled boolean");
  }

  const events = value.events
    .map((event) => event.trim())
    .filter((event) => event.length > 0);
  const secret = parseOptionalString(value.secret);

  return {
    url,
    events,
    enabled,
    ...(secret === undefined ? {} : { secret })
  };
};

const parseWebhookConfigs = (value: string | undefined): WebhookConfig[] | undefined => {
  if (value === undefined || value.trim().length === 0 || value.trim() === "undefined") {
    return undefined;
  }

  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("VEGA_WEBHOOKS must be a JSON array");
  }

  return parsed.map((entry) => parseWebhookConfig(entry));
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const parseCloudBackupProvider = (
  value: string | undefined
): CloudBackupConfig["provider"] | undefined => {
  switch (parseOptionalString(value)?.toLowerCase()) {
    case "local-sync":
      return "local-sync";
    case "s3":
      return "s3";
    case "gdrive":
      return "gdrive";
    case "icloud":
      return "icloud";
    default:
      return undefined;
  }
};

const parseStringArray = (value: string | undefined): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : undefined;
};

const parseRegressionGuardConfig = (): RegressionGuardConfig => ({
  maxSessionStartToken: clamp(
    parseNumber(process.env.VEGA_REGRESSION_MAX_SESSION_START_TOKEN, 2500),
    0,
    100_000
  ),
  maxRecallLatencyMs: clamp(
    parseNumber(process.env.VEGA_REGRESSION_MAX_RECALL_LATENCY_MS, 500),
    0,
    60_000
  ),
  minRecallAvgSimilarity: clamp(
    parseNumber(process.env.VEGA_REGRESSION_MIN_RECALL_AVG_SIMILARITY, 0.4),
    0,
    1
  ),
  maxTopKInflationRatio: clamp(
    parseNumber(process.env.VEGA_REGRESSION_MAX_TOP_K_INFLATION_RATIO, 0.3),
    0,
    1
  )
});

const parseFeatureFlags = (): VegaFeatureFlags => ({
  factClaims: parseBoolean(process.env.VEGA_FEATURE_FACT_CLAIMS, DEFAULT_FEATURE_FLAGS.factClaims),
  rawArchive: parseBoolean(process.env.VEGA_FEATURE_RAW_ARCHIVE, DEFAULT_FEATURE_FLAGS.rawArchive),
  topicRecall: parseBoolean(
    process.env.VEGA_FEATURE_TOPIC_RECALL,
    DEFAULT_FEATURE_FLAGS.topicRecall
  ),
  deepRecall: parseBoolean(process.env.VEGA_FEATURE_DEEP_RECALL, DEFAULT_FEATURE_FLAGS.deepRecall),
  codeGraph: parseBoolean(process.env.VEGA_FEATURE_CODE_GRAPH, DEFAULT_FEATURE_FLAGS.codeGraph),
  consolidationReport: parseBoolean(
    process.env.VEGA_FEATURE_CONSOLIDATION_REPORT,
    DEFAULT_FEATURE_FLAGS.consolidationReport
  ),
  consolidationAutoExecute: parseBoolean(
    process.env.VEGA_FEATURE_CONSOLIDATION_AUTO_EXECUTE,
    DEFAULT_FEATURE_FLAGS.consolidationAutoExecute
  )
});

const getConfigFilePath = (): string => join(homedir(), ".vega", "config.json");

const loadFileConfig = (): Partial<
  Pick<
    VegaConfig,
    "mode" | "serverUrl" | "apiKey" | "cacheDbPath" | "dbEncryption" | "customRedactionPatterns"
  >
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
      dbEncryption: parseOptionalBoolean(parsed.db_encryption ?? parsed.dbEncryption),
      customRedactionPatterns: parseCustomRedactionPatterns(
        parsed.custom_redaction_patterns ?? parsed.customRedactionPatterns
      )
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
  const provider = parseCloudBackupProvider(process.env.VEGA_CLOUD_BACKUP_TYPE);

  if (provider === undefined) {
    if (!destDir) {
      return undefined;
    }

    return {
      enabled: true,
      provider: "local-sync",
      destDir: expandHomePath(destDir)
    };
  }

  if (provider === "local-sync") {
    if (!destDir) {
      return undefined;
    }

    return {
      enabled: true,
      provider,
      destDir: expandHomePath(destDir)
    };
  }

  if (provider === "s3") {
    return {
      enabled: true,
      provider,
      bucket: process.env.VEGA_S3_BUCKET ?? "",
      region: process.env.VEGA_S3_REGION ?? "",
      accessKeyId: process.env.VEGA_S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: process.env.VEGA_S3_SECRET_ACCESS_KEY || undefined
    };
  }

  if (provider === "gdrive") {
    return {
      enabled: true,
      provider
    };
  }

  return {
    enabled: true,
    provider,
    containerPath: process.env.VEGA_ICLOUD_CONTAINER_PATH || undefined
  };
};

export const loadConfig = (): VegaConfig => {
  const fileConfig = loadFileConfig();
  const dbEncryption =
    process.env.VEGA_DB_ENCRYPTION === undefined
      ? fileConfig.dbEncryption ?? false
      : process.env.VEGA_DB_ENCRYPTION === "true";
  const encryptionKey = process.env.VEGA_ENCRYPTION_KEY || undefined;
  const webhooks = parseWebhookConfigs(process.env.VEGA_WEBHOOKS);

  return {
    dbPath: expandHomePath(process.env.VEGA_DB_PATH ?? "./data/memory.db"),
    dbEncryption,
    consolidationCronEnabled: parseBoolean(process.env.VEGA_CONSOLIDATION_CRON, false),
    consolidationCronIntervalMs: Math.max(
      1_000,
      parseNumber(process.env.VEGA_CONSOLIDATION_CRON_INTERVAL_MS, 24 * 60 * 60 * 1000)
    ),
    sessionIncludeGraphReport: parseBoolean(process.env.VEGA_SESSION_INCLUDE_GRAPH_REPORT, false),
    byokEnabled: parseBoolean(process.env.VEGA_BYOK_ENABLED, false),
    csrfEnabled: parseBoolean(process.env.VEGA_CSRF_ENABLED, false),
    corsOrigins: parseStringArray(process.env.VEGA_CORS_ORIGINS),
    databaseType: parseDatabaseType(process.env.VEGA_DATABASE_TYPE),
    metricsEnabled: parseBoolean(process.env.VEGA_METRICS_ENABLED, false),
    sentryDsn: process.env.VEGA_SENTRY_DSN || undefined,
    logLevel: parseLogLevel(process.env.VEGA_LOG_LEVEL),
    logFormat: parseLogFormat(process.env.VEGA_LOG_FORMAT),
    embeddingProvider:
      process.env.VEGA_EMBEDDING_PROVIDER === "openai"
        ? "openai"
        : process.env.VEGA_EMBEDDING_PROVIDER === "azure-openai"
          ? "azure-openai"
          : process.env.VEGA_EMBEDDING_PROVIDER === "bedrock"
            ? "bedrock"
            : "ollama",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL ?? "bge-m3",
    openaiApiKey: process.env.VEGA_OPENAI_API_KEY || undefined,
    openaiBaseUrl: process.env.VEGA_OPENAI_BASE_URL || undefined,
    openaiEmbeddingModel: process.env.VEGA_OPENAI_EMBEDDING_MODEL || undefined,
    azureOpenaiApiKey: process.env.VEGA_AZURE_OPENAI_API_KEY || undefined,
    azureOpenaiBaseUrl: process.env.VEGA_AZURE_OPENAI_BASE_URL || undefined,
    azureOpenaiApiVersion: process.env.VEGA_AZURE_OPENAI_API_VERSION || undefined,
    azureOpenaiChatDeployment: process.env.VEGA_AZURE_OPENAI_CHAT_DEPLOYMENT || undefined,
    azureOpenaiEmbeddingDeployment: process.env.VEGA_AZURE_OPENAI_EMBEDDING_DEPLOYMENT || undefined,
    bedrockRegion: process.env.VEGA_BEDROCK_REGION || undefined,
    bedrockChatModel: process.env.VEGA_BEDROCK_CHAT_MODEL || undefined,
    bedrockEmbeddingModel: process.env.VEGA_BEDROCK_EMBEDDING_MODEL || undefined,
    tokenBudget: clamp(parseNumber(process.env.VEGA_TOKEN_BUDGET, 2000), 500, 10_000),
    similarityThreshold: clamp(parseNumber(process.env.VEGA_SIMILARITY_THRESHOLD, 0.85), 0, 1),
    shardingEnabled: parseBoolean(process.env.VEGA_SHARDING_ENABLED, false),
    backupRetentionDays: clamp(
      parseNumber(process.env.VEGA_BACKUP_RETENTION_DAYS, 7),
      1,
      365
    ),
    archiveMaxSizeMb: clamp(parseNumber(process.env.VEGA_ARCHIVE_MAX_SIZE_MB, 500), 1, 100_000),
    archivePreserveRaw: parseBoolean(process.env.VEGA_ARCHIVE_PRESERVE_RAW, false),
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
    slackWebhookUrl: process.env.VEGA_SLACK_WEBHOOK_URL || undefined,
    slackBotToken: process.env.VEGA_SLACK_BOT_TOKEN || undefined,
    slackChannel: process.env.VEGA_SLACK_CHANNEL || undefined,
    slackEnabled: parseBoolean(process.env.VEGA_SLACK_ENABLED, false),
    openclawUrl: process.env.VEGA_OPENCLAW_URL || undefined,
    openclawKey: process.env.VEGA_OPENCLAW_KEY || undefined,
    openclawEnabled: parseBoolean(process.env.VEGA_OPENCLAW_ENABLED, false),
    stripeSecretKey: process.env.VEGA_STRIPE_SECRET_KEY || undefined,
    stripeWebhookSecret: process.env.VEGA_STRIPE_WEBHOOK_SECRET || undefined,
    stripePublishableKey: process.env.VEGA_STRIPE_PUBLISHABLE_KEY || undefined,
    stripeEnabled: parseBoolean(process.env.VEGA_STRIPE_ENABLED, false),
    oidcIssuerUrl: process.env.VEGA_OIDC_ISSUER_URL || undefined,
    oidcClientId: process.env.VEGA_OIDC_CLIENT_ID || undefined,
    oidcClientSecret: process.env.VEGA_OIDC_CLIENT_SECRET || undefined,
    oidcCallbackUrl: process.env.VEGA_OIDC_CALLBACK_URL || undefined,
    redisUrl: process.env.VEGA_REDIS_URL || undefined,
    redisHost: process.env.VEGA_REDIS_HOST || undefined,
    redisPort: parseOptionalNumber(process.env.VEGA_REDIS_PORT),
    redisPassword: process.env.VEGA_REDIS_PASSWORD || undefined,
    redisDb: parseOptionalNumber(process.env.VEGA_REDIS_DB),
    redisEnabled: parseBoolean(process.env.VEGA_REDIS_ENABLED, false),
    queueEnabled: parseBoolean(process.env.VEGA_QUEUE_ENABLED, false),
    queueRedisUrl: process.env.VEGA_QUEUE_REDIS_URL || undefined,
    queueConcurrency: parseNumber(process.env.VEGA_QUEUE_CONCURRENCY, 1),
    pgHost: process.env.VEGA_PG_HOST || undefined,
    pgPort: parseOptionalNumber(process.env.VEGA_PG_PORT),
    pgDatabase: process.env.VEGA_PG_DATABASE || undefined,
    pgUser: process.env.VEGA_PG_USER || undefined,
    pgPassword: process.env.VEGA_PG_PASSWORD || undefined,
    pgSsl: parseOptionalBoolean(process.env.VEGA_PG_SSL),
    pgSchema: process.env.VEGA_PG_SCHEMA || undefined,
    ...(encryptionKey === undefined ? {} : { encryptionKey }),
    cloudBackup: parseCloudBackup(),
    regressionGuard: parseRegressionGuardConfig(),
    features: parseFeatureFlags(),
    customRedactionPatterns: fileConfig.customRedactionPatterns ?? [],
    ...(webhooks === undefined ? {} : { webhooks })
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
