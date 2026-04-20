import { createLogger, type Logger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";

import type {
  DetectExpiredCheckpointsOptions,
  DetectedTimeout
} from "./detector.js";
import { detectExpiredCheckpoints } from "./detector.js";
import type { TimeoutSweepConfig } from "./config.js";
import { classifyTimeout, type TimeoutPolicyDecision } from "./policy.js";
import {
  recordTimeoutFailure,
  type RecordTimeoutFailureInput,
  type TimeoutSweepRecorderResult
} from "./recorder.js";

const logger = createLogger({ name: "timeout-scheduler" });

export interface TimeoutSweepSchedulerOptions {
  db: DatabaseAdapter;
  config: TimeoutSweepConfig;
  detector?: (
    db: DatabaseAdapter,
    options: DetectExpiredCheckpointsOptions
  ) => DetectedTimeout[] | Promise<DetectedTimeout[]>;
  policy?: (detected: DetectedTimeout) => TimeoutPolicyDecision;
  recorder?: (
    db: DatabaseAdapter,
    input: RecordTimeoutFailureInput
  ) => TimeoutSweepRecorderResult | Promise<TimeoutSweepRecorderResult>;
  now?: () => number;
  logger?: Logger;
}

export class TimeoutSweepScheduler {
  readonly #db: DatabaseAdapter;
  readonly #config: TimeoutSweepConfig;
  readonly #detector: NonNullable<TimeoutSweepSchedulerOptions["detector"]>;
  readonly #policy: NonNullable<TimeoutSweepSchedulerOptions["policy"]>;
  readonly #recorder: NonNullable<TimeoutSweepSchedulerOptions["recorder"]>;
  readonly #now: () => number;
  readonly #logger: Logger;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: TimeoutSweepSchedulerOptions) {
    this.#db = options.db;
    this.#config = options.config;
    this.#detector = options.detector ?? detectExpiredCheckpoints;
    this.#policy = options.policy ?? classifyTimeout;
    this.#recorder = options.recorder ?? recordTimeoutFailure;
    this.#now = options.now ?? (() => Date.now());
    this.#logger = options.logger ?? logger;
  }

  start(): void {
    if (!this.#config.enabled || this.#timer !== null) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#config.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === null) {
      return;
    }

    clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<number> {
    const detectedAt = this.#now();

    try {
      const detected = await Promise.resolve(
        this.#detector(this.#db, {
          now: detectedAt,
          maxPerRun: this.#config.maxPerRun
        })
      );

      for (const entry of detected) {
        const decision = this.#policy(entry);
        await Promise.resolve(
          this.#recorder(this.#db, {
            checkpoint_id: entry.checkpoint_id,
            decision: decision.decision,
            reason: decision.reason,
            detected_at: detectedAt,
            intent: entry.intent,
            surface: entry.surface ?? null,
            session_id: entry.session_id ?? null,
            project: entry.project ?? null,
            cwd: entry.cwd ?? null,
            query_hash: entry.query_hash ?? null,
            mode: entry.mode ?? null,
            profile_used: entry.profile_used ?? null,
            ranker_version: entry.ranker_version ?? null,
            expires_at: entry.expires_at,
            host_tier: entry.host_tier,
            logger: this.#logger
          })
        );
      }

      return detected.length;
    } catch (error) {
      this.#logger.warn("Timeout sweep scheduler tick failed.", {
        error: error instanceof Error ? error.message : String(error)
      });
      return 0;
    }
  }
}
