export interface VegaConfig {
  dbPath: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  tokenBudget: number;
  similarityThreshold: number;
  backupRetentionDays: number;
  apiPort: number;
  apiKey: string | undefined;
}

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const loadConfig = (): VegaConfig => ({
  dbPath: process.env.VEGA_DB_PATH ?? "./data/memory.db",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "bge-m3",
  tokenBudget: clamp(parseNumber(process.env.VEGA_TOKEN_BUDGET, 2000), 500, 10_000),
  similarityThreshold: clamp(parseNumber(process.env.VEGA_SIMILARITY_THRESHOLD, 0.85), 0, 1),
  backupRetentionDays: clamp(
    parseNumber(process.env.VEGA_BACKUP_RETENTION_DAYS, 7),
    1,
    365
  ),
  apiPort: parseNumber(process.env.VEGA_API_PORT, 3271),
  apiKey: process.env.VEGA_API_KEY || undefined
});
