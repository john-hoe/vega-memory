import type { DatabaseAdapter } from "../db/adapter.js";
import { RAW_INBOX_TABLE } from "./raw-inbox.js";
import type { ShadowWriteOutcome } from "./shadow-writer.js";

export interface DualWriteCounters {
  shadow_attempts: number;
  shadow_success: number;
  shadow_deduped: number;
  shadow_disabled: number;
  shadow_errors: number;
}

const createEmptyCounters = (): DualWriteCounters => ({
  shadow_attempts: 0,
  shadow_success: 0,
  shadow_deduped: 0,
  shadow_disabled: 0,
  shadow_errors: 0
});

export class DualWriteMonitor {
  readonly counters: DualWriteCounters = createEmptyCounters();

  recordOutcome(outcome: ShadowWriteOutcome): void {
    if (!outcome.executed) {
      this.counters.shadow_disabled += 1;
      return;
    }

    this.counters.shadow_attempts += 1;

    if (outcome.accepted) {
      this.counters.shadow_success += 1;
      return;
    }

    if (outcome.reason === "deduped") {
      this.counters.shadow_deduped += 1;
      return;
    }

    if (outcome.reason === "error") {
      this.counters.shadow_errors += 1;
    }
  }

  reset(): void {
    Object.assign(this.counters, createEmptyCounters());
  }

  snapshot(): DualWriteCounters {
    return { ...this.counters };
  }
}

interface RawInboxPresenceRow {
  present: number;
}

export function compareSingleWrite(
  db: DatabaseAdapter,
  event_id: string
): { raw_inbox_present: boolean } {
  const row = db.get<RawInboxPresenceRow>(
    `SELECT 1 AS present FROM ${RAW_INBOX_TABLE} WHERE event_id = ? LIMIT 1`,
    event_id
  );

  return {
    raw_inbox_present: row?.present === 1
  };
}
