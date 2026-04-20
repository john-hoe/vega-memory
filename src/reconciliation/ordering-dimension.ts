import type { DatabaseAdapter } from "../db/adapter.js";

import type {
  ReconciliationDimensionExecution,
  ReconciliationFindingRecord
} from "./report.js";

interface OrderingWindowRow {
  id: string;
  created_at: string;
  raw_event_type: string;
  received_at: string;
}

const DEFAULT_TOLERANCE_MS = 5000;

export async function runOrderingDimension(args: {
  db: DatabaseAdapter;
  window_start: number;
  window_end: number;
  tolerance_ms?: number;
}): Promise<ReconciliationDimensionExecution> {
  try {
    const rows = listOrderingWindowRows(args.db, args.window_start, args.window_end);
    const toleranceMs = resolveToleranceMs(args.tolerance_ms);
    const aggregates = new Map<
      string,
      {
        event_type: string;
        mismatch_count: number;
        sample_ids: string[];
        max_delta_ms: number;
      }
    >();

    for (const row of rows) {
      const deltaMs = Math.abs(toEpochMs(row.received_at) - toEpochMs(row.created_at));
      if (deltaMs <= toleranceMs) {
        continue;
      }

      const existing = aggregates.get(row.raw_event_type);
      if (existing !== undefined) {
        existing.mismatch_count += 1;
        existing.max_delta_ms = Math.max(existing.max_delta_ms, deltaMs);
        if (existing.sample_ids.length < 10) {
          existing.sample_ids.push(row.id);
        }
        continue;
      }

      aggregates.set(row.raw_event_type, {
        event_type: row.raw_event_type,
        mismatch_count: 1,
        sample_ids: [row.id],
        max_delta_ms: deltaMs
      });
    }

    const findings =
      aggregates.size > 0
        ? Array.from(aggregates.values())
            .sort((left, right) => left.event_type.localeCompare(right.event_type))
            .map((aggregate) => ({
              status: "fail" as const,
              event_type: aggregate.event_type,
              mismatch_count: aggregate.mismatch_count,
              sample_ids: [...aggregate.sample_ids],
              payload: {
                mismatch_type: "timestamp_drift",
                sample_ids: [...aggregate.sample_ids],
                delta_ms: aggregate.max_delta_ms
              }
            }))
        : [createPassFinding()];

    return {
      dimension: "ordering",
      status: aggregates.size > 0 ? "fail" : "pass",
      findings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      dimension: "ordering",
      status: "error",
      error: message,
      findings: [createErrorFinding(message)]
    };
  }
}

function listOrderingWindowRows(
  db: DatabaseAdapter,
  windowStart: number,
  windowEnd: number
): OrderingWindowRow[] {
  return db
    .prepare<[string, string], OrderingWindowRow>(
      `SELECT
         memory.id,
         memory.created_at,
         raw.event_type AS raw_event_type,
         raw.received_at
       FROM memories AS memory
       INNER JOIN raw_inbox AS raw
         ON raw.event_id = memory.id
       WHERE ? <= memory.created_at AND memory.created_at < ?
       ORDER BY memory.created_at ASC, memory.id ASC`
    )
    .all(toIso(windowStart), toIso(windowEnd));
}

function resolveToleranceMs(value?: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  const parsed = Number.parseInt(process.env.VEGA_RECONCILIATION_ORDERING_TOLERANCE_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TOLERANCE_MS;
}

function toEpochMs(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }

  return parsed;
}

function createPassFinding(): ReconciliationFindingRecord {
  return {
    status: "pass",
    mismatch_count: 0,
    payload: {
      status: "pass"
    }
  };
}

function createErrorFinding(message: string): ReconciliationFindingRecord {
  return {
    status: "error",
    mismatch_count: 0,
    payload: {
      error: message
    }
  };
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
