import { createLogger, type Logger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";

import { DEFAULT_TIMEOUT_SWEEP_MAX_PER_RUN } from "./config.js";
import { inspectExpiredCheckpoints } from "./detector.js";
import { classifyTimeout } from "./policy.js";
import { recordTimeoutFailure } from "./recorder.js";

const logger = createLogger({ name: "timeout-mcp" });

export interface SweepCheckpointTimeoutsOptions {
  now?: number;
  maxPerRun?: number;
  logger?: Logger;
}

export interface SweepCheckpointTimeoutsResult {
  schema_version: "1.0";
  swept_at: string;
  detected_count: number;
  hard_failures: number;
  degraded_events: number;
  records: Array<{
    checkpoint_id: string;
    decision: "presumed_sufficient" | "hard_failure";
    reason: string;
  }>;
  degraded?: "schema_incompatible" | "sqlite_only";
}

export async function sweepCheckpointTimeouts(
  db: DatabaseAdapter,
  options: SweepCheckpointTimeoutsOptions = {}
): Promise<SweepCheckpointTimeoutsResult> {
  const activeLogger = options.logger ?? logger;
  const detectedAt = options.now ?? Date.now();
  const sweptAt = new Date(detectedAt).toISOString();
  const maxPerRun =
    options.maxPerRun !== undefined && Number.isInteger(options.maxPerRun) && options.maxPerRun > 0
      ? options.maxPerRun
      : DEFAULT_TIMEOUT_SWEEP_MAX_PER_RUN;

  if (db.isPostgres) {
    return {
      schema_version: "1.0",
      swept_at: sweptAt,
      detected_count: 0,
      hard_failures: 0,
      degraded_events: 0,
      records: [],
      degraded: "sqlite_only"
    };
  }

  try {
    const detection = inspectExpiredCheckpoints(db, {
      now: detectedAt,
      maxPerRun,
      logger: activeLogger
    });
    if (detection.degraded !== undefined) {
      return {
        schema_version: "1.0",
        swept_at: sweptAt,
        detected_count: 0,
        hard_failures: 0,
        degraded_events: 0,
        records: [],
        degraded: detection.degraded
      };
    }

    let hardFailures = 0;
    let degradedEvents = 0;
    const records: SweepCheckpointTimeoutsResult["records"] = [];

    for (const entry of detection.records) {
      const decision = classifyTimeout(entry);
      await Promise.resolve(
        recordTimeoutFailure(db, {
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
          logger: activeLogger
        })
      );

      if (decision.decision === "hard_failure") {
        hardFailures += 1;
      } else {
        degradedEvents += 1;
      }

      records.push({
        checkpoint_id: entry.checkpoint_id,
        decision: decision.decision,
        reason: decision.reason
      });
    }

    return {
      schema_version: "1.0",
      swept_at: sweptAt,
      detected_count: detection.records.length,
      hard_failures: hardFailures,
      degraded_events: degradedEvents,
      records
    };
  } catch (error) {
    activeLogger.warn("checkpoint.timeout_sweep failed.", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      schema_version: "1.0",
      swept_at: sweptAt,
      detected_count: 0,
      hard_failures: 0,
      degraded_events: 0,
      records: [],
      degraded: "schema_incompatible"
    };
  }
}
