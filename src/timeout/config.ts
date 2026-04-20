export interface TimeoutSweepConfig {
  intervalMs: number;
  maxPerRun: number;
  enabled: boolean;
}

export const DEFAULT_TIMEOUT_SWEEP_INTERVAL_MS = 60_000;
export const DEFAULT_TIMEOUT_SWEEP_MAX_PER_RUN = 100;

export function resolveTimeoutSweepConfig(
  env: Record<string, string | undefined> = process.env
): TimeoutSweepConfig {
  const intervalMs = (() => {
    const parsed = Number.parseInt(env.VEGA_TIMEOUT_SWEEP_INTERVAL_MS ?? "", 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_SWEEP_INTERVAL_MS;
  })();
  const maxPerRun = (() => {
    const parsed = Number.parseInt(env.VEGA_TIMEOUT_SWEEP_MAX_PER_RUN ?? "", 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_SWEEP_MAX_PER_RUN;
  })();

  return {
    intervalMs,
    maxPerRun,
    enabled: env.VEGA_TIMEOUT_SWEEP_ENABLED !== "false"
  };
}
