export interface VegaConfig {
  dbPath: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  tokenBudget: number;
  similarityThreshold: number;
  backupRetentionDays: number;
}

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const loadConfig = (): VegaConfig => ({
  dbPath: process.env.VEGA_DB_PATH ?? "./data/memory.db",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "bge-m3",
  tokenBudget: parseNumber(process.env.VEGA_TOKEN_BUDGET, 2000),
  similarityThreshold: parseNumber(process.env.VEGA_SIMILARITY_THRESHOLD, 0.85),
  backupRetentionDays: parseNumber(process.env.VEGA_BACKUP_RETENTION_DAYS, 7)
});
