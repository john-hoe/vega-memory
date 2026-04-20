import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";

import type {
  ReconciliationDimensionExecution,
  ReconciliationDirection,
  ReconciliationFindingRecord
} from "./report.js";

interface MemoryWindowRow {
  id: string;
  source: "auto" | "explicit";
  source_context: string | null;
}

interface RawInboxWindowRow {
  event_id: string;
  event_type: "decision" | "state_change";
}

interface MemoryIdRow {
  id: string;
}

interface ParsedSourceContext {
  integration?: string;
}

const logger = createLogger({ name: "reconciliation-count" });
const COUNT_EVENT_TYPES = ["decision", "state_change"] as const;

export async function runCountDimension(args: {
  db: DatabaseAdapter;
  window_start: number;
  window_end: number;
}): Promise<ReconciliationDimensionExecution> {
  const memories = listTrackedMemories(args.db, args.window_start, args.window_end);
  const rawRows = listRawInboxRows(args.db, args.window_start, args.window_end);
  const rawByEventId = new Map(rawRows.map((row) => [row.event_id, row.event_type]));
  const memoryIdsByEventType = {
    decision: [] as string[],
    state_change: [] as string[]
  };

  for (const memory of memories) {
    memoryIdsByEventType[classifyEventType(memory)].push(memory.id);
  }

  const rawIds = rawRows.map((row) => row.event_id);
  const existingMemoryIds = rawIds.length > 0 ? new Set(resolveExistingMemoryIds(args.db, rawIds)) : new Set<string>();
  const findings: ReconciliationFindingRecord[] = [];

  for (const eventType of COUNT_EVENT_TYPES) {
    findings.push(
      createFinding(
        "forward",
        eventType,
        memoryIdsByEventType[eventType],
        memoryIdsByEventType[eventType].filter((id) => rawByEventId.get(id) === eventType)
      )
    );
  }

  for (const eventType of COUNT_EVENT_TYPES) {
    const expectedIds = rawRows
      .filter((row) => row.event_type === eventType)
      .map((row) => row.event_id);
    findings.push(
      createFinding(
        "reverse",
        eventType,
        expectedIds,
        expectedIds.filter((id) => existingMemoryIds.has(id))
      )
    );
  }

  return {
    dimension: "count",
    status: findings.some((finding) => finding.status === "fail") ? "fail" : "pass",
    findings
  };
}

function listTrackedMemories(
  db: DatabaseAdapter,
  windowStart: number,
  windowEnd: number
): MemoryWindowRow[] {
  return db
    .prepare<[string, string], MemoryWindowRow>(
      `SELECT id, source, source_context
       FROM memories
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(toIso(windowStart), toIso(windowEnd))
    .filter((memory) => isTrackedMemory(memory));
}

function listRawInboxRows(
  db: DatabaseAdapter,
  windowStart: number,
  windowEnd: number
): RawInboxWindowRow[] {
  return db
    .prepare<[string, string], RawInboxWindowRow>(
      `SELECT event_id, event_type
       FROM raw_inbox
       WHERE host_timestamp >= ? AND host_timestamp < ?
         AND event_type IN ('decision', 'state_change')
       ORDER BY host_timestamp ASC, event_id ASC`
    )
    .all(toIso(windowStart), toIso(windowEnd));
}

function resolveExistingMemoryIds(db: DatabaseAdapter, ids: string[]): string[] {
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare<unknown[], MemoryIdRow>(
      `SELECT id FROM memories WHERE id IN (${placeholders})`
    )
    .all(...ids)
    .map((row) => row.id);
}

function createFinding(
  direction: ReconciliationDirection,
  eventType: (typeof COUNT_EVENT_TYPES)[number],
  expectedIds: string[],
  actualIds: string[]
): ReconciliationFindingRecord {
  const mismatchCount = clampMismatch(expectedIds.length - actualIds.length, {
    direction,
    event_type: eventType,
    expected: expectedIds.length,
    actual: actualIds.length
  });
  const sampleIds = expectedIds.filter((id) => !actualIds.includes(id)).slice(0, 10);

  return {
    status: mismatchCount === 0 ? "pass" : "fail",
    event_type: eventType,
    direction,
    expected: expectedIds.length,
    actual: actualIds.length,
    mismatch_count: mismatchCount,
    sample_ids: sampleIds,
    payload: {
      sample_ids: sampleIds
    }
  };
}

function classifyEventType(memory: MemoryWindowRow): "decision" | "state_change" {
  if (memory.source === "explicit") {
    return "decision";
  }

  const sourceContext = parseSourceContext(memory.source_context);
  return sourceContext?.integration === "candidate_promotion" ? "state_change" : "decision";
}

function isTrackedMemory(memory: MemoryWindowRow): boolean {
  if (memory.source === "explicit") {
    return true;
  }

  const sourceContext = parseSourceContext(memory.source_context);
  return sourceContext?.integration === "candidate_promotion";
}

function parseSourceContext(value: string | null): ParsedSourceContext | null {
  if (value === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as ParsedSourceContext) : null;
  } catch {
    return null;
  }
}

function clampMismatch(
  value: number,
  context: Record<string, unknown>
): number {
  if (value >= 0) {
    return value;
  }

  logger.warn("Negative reconciliation mismatch_count clamped to zero", context);
  return 0;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
