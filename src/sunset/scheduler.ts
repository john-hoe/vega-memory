import { createLogger, type Logger } from "../core/logging/index.js";

import type { SunsetEvaluationResult } from "./evaluator.js";
import type { SunsetCandidate } from "./registry.js";
import type { SunsetNotifier } from "./notifier.js";

export const DEFAULT_SUNSET_CHECK_INTERVAL_MS = 86_400_000;
export type { SunsetEvaluationResult } from "./evaluator.js";

const logger = createLogger({ name: "sunset-scheduler" });

const toDateKey = (value: Date): string => value.toISOString().slice(0, 10);

export const resolveSunsetCheckIntervalMs = (): number => {
  const parsed = Number.parseInt(process.env.VEGA_SUNSET_CHECK_INTERVAL_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SUNSET_CHECK_INTERVAL_MS;
};

export interface SunsetSchedulerOptions {
  registry: () => Promise<SunsetCandidate[]> | SunsetCandidate[];
  evaluator: (
    candidates: SunsetCandidate[]
  ) => Promise<SunsetEvaluationResult[]> | SunsetEvaluationResult[];
  notifier: SunsetNotifier;
  intervalMs?: number;
  logger?: Logger;
  now?: () => Date;
}

export class SunsetScheduler {
  readonly #registry: SunsetSchedulerOptions["registry"];
  readonly #evaluator: SunsetSchedulerOptions["evaluator"];
  readonly #notifier: SunsetNotifier;
  readonly #intervalMs: number;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #notifiedForDay = new Set<string>();
  #timer: NodeJS.Timeout | null = null;

  constructor(options: SunsetSchedulerOptions) {
    this.#registry = options.registry;
    this.#evaluator = options.evaluator;
    this.#notifier = options.notifier;
    this.#intervalMs = options.intervalMs ?? resolveSunsetCheckIntervalMs();
    this.#logger = options.logger ?? logger;
    this.#now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === null) {
      return;
    }

    clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<SunsetEvaluationResult[]> {
    const dayKey = toDateKey(this.#now());
    this.#pruneNotified(dayKey);

    try {
      const candidates = await Promise.resolve(this.#registry());
      const results = await Promise.resolve(this.#evaluator(candidates));
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));

      for (const result of results) {
        if (result.status !== "ready") {
          continue;
        }

        const candidate = candidateById.get(result.candidate_id);
        if (candidate === undefined) {
          continue;
        }

        const dedupeKey = `${result.candidate_id}@${dayKey}`;
        if (this.#notifiedForDay.has(dedupeKey)) {
          continue;
        }

        this.#notifiedForDay.add(dedupeKey);

        try {
          await this.#notifier({
            candidate,
            evaluation: result
          });
        } catch (error) {
          this.#logger.warn("Sunset notifier rejected.", {
            candidate_id: result.candidate_id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return results;
    } catch (error) {
      this.#logger.warn("Sunset scheduler tick failed.", {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  #pruneNotified(dayKey: string): void {
    for (const key of this.#notifiedForDay) {
      if (key.endsWith(`@${dayKey}`)) {
        continue;
      }

      this.#notifiedForDay.delete(key);
    }
  }
}
