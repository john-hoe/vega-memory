import { createLogger, type Logger } from "../core/logging/index.js";

import type { AlertEvaluation } from "./evaluator.js";
import type { AlertRule } from "./rules.js";
import {
  applyAlertHistoryMigration,
  isInCooldown,
  markAlertResolved,
  recordAlertFired
} from "./history.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import type {
  AlertChannel,
  AlertDispatchResult,
  AlertPayload
} from "./channels/index.js";

export const DEFAULT_ALERT_CHECK_INTERVAL_MS = 60_000;
export const DEFAULT_ALERT_COOLDOWN_MS = 1_800_000;

const logger = createLogger({ name: "alert-scheduler" });

export const resolveAlertCheckIntervalMs = (): number => {
  const parsed = Number.parseInt(process.env.VEGA_ALERT_CHECK_INTERVAL_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ALERT_CHECK_INTERVAL_MS;
};

export const resolveAlertCooldownMs = (): number => {
  const parsed = Number.parseInt(process.env.VEGA_ALERT_COOLDOWN_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ALERT_COOLDOWN_MS;
};

export interface AlertSchedulerOptions {
  db: DatabaseAdapter;
  rules: AlertRule[];
  channels: AlertChannel[];
  evaluator: () => Promise<AlertEvaluation[]> | AlertEvaluation[];
  cooldownMs?: number;
  intervalMs?: number;
  logger?: Logger;
  now?: () => Date;
  dispatch?: (channel: AlertChannel, payload: AlertPayload) => Promise<AlertDispatchResult>;
}

const toDispatchStatus = (result: AlertDispatchResult): string =>
  result.status === "ok" ? "ok" : `error:${result.message}`;

const buildAlertPayload = (
  rule: AlertRule,
  value: number,
  firedAt: string,
  reason?: string
): AlertPayload => ({
  alert_id: rule.id,
  severity: rule.severity,
  value,
  threshold: rule.threshold,
  fired_at: firedAt,
  message: reason ?? `${rule.id} crossed ${rule.operator} ${rule.threshold}`
});

export class AlertScheduler {
  readonly #db: DatabaseAdapter;
  readonly #rules: AlertRule[];
  readonly #channels: Map<string, AlertChannel>;
  readonly #evaluator: AlertSchedulerOptions["evaluator"];
  readonly #cooldownMs: number;
  readonly #intervalMs: number;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #dispatch: (channel: AlertChannel, payload: AlertPayload) => Promise<AlertDispatchResult>;
  #migrationApplied = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: AlertSchedulerOptions) {
    this.#db = options.db;
    this.#rules = options.rules;
    this.#channels = new Map(options.channels.map((channel) => [channel.id, channel]));
    this.#evaluator = options.evaluator;
    this.#cooldownMs = options.cooldownMs ?? resolveAlertCooldownMs();
    this.#intervalMs = options.intervalMs ?? resolveAlertCheckIntervalMs();
    this.#logger = options.logger ?? logger;
    this.#now = options.now ?? (() => new Date());
    this.#dispatch =
      options.dispatch ??
      (async (channel, payload) => {
        try {
          return await channel.send(payload);
        } catch (error) {
          return {
            status: "error",
            message: error instanceof Error ? error.message : String(error)
          };
        }
      });
  }

  start(): void {
    this.#ensureMigration();

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

  async fireRule(
    rule: AlertRule,
    options: {
      value?: number;
      reason?: string;
      firedAt?: Date;
    } = {}
  ): Promise<Record<string, string>> {
    this.#ensureMigration();

    const firedAt = options.firedAt ?? this.#now();
    const firedAtIso = firedAt.toISOString();
    const firedAtMs = firedAt.getTime();
    const value = options.value ?? rule.threshold;
    const dispatchStatus: Record<string, string> = {};

    for (const channelId of rule.channels) {
      const channel = this.#channels.get(channelId);
      if (channel === undefined) {
        dispatchStatus[channelId] = "error:channel_not_found";
        continue;
      }

      const result = await this.#dispatch(
        channel,
        buildAlertPayload(rule, value, firedAtIso, options.reason)
      );
      dispatchStatus[channelId] = toDispatchStatus(result);
    }

    recordAlertFired(this.#db, {
      rule_id: rule.id,
      severity: rule.severity,
      value,
      fired_at: firedAtMs,
      channels: rule.channels,
      dispatch_status: dispatchStatus
    });

    return dispatchStatus;
  }

  async tick(): Promise<AlertEvaluation[]> {
    this.#ensureMigration();

    try {
      const evaluations = await Promise.resolve(this.#evaluator());

      for (const evaluation of evaluations) {
        const rule = this.#rules.find((entry) => entry.id === evaluation.rule_id);
        if (rule === undefined) {
          continue;
        }

        if (evaluation.state === "firing" && evaluation.value !== null) {
          const nowMs = this.#now().getTime();
          if (isInCooldown(this.#db, rule.id, nowMs, this.#cooldownMs)) {
            continue;
          }

          await this.fireRule(rule, {
            value: evaluation.value,
            reason: evaluation.reasons.join(", ")
          });
          continue;
        }

        if (evaluation.state === "resolved") {
          markAlertResolved(this.#db, rule.id, this.#now().getTime());
        }
      }

      return evaluations;
    } catch (error) {
      this.#logger.warn("Alert scheduler tick failed.", {
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  #ensureMigration(): void {
    if (this.#migrationApplied) {
      return;
    }

    applyAlertHistoryMigration(this.#db);
    this.#migrationApplied = true;
  }
}
