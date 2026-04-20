import { memoryToEnvelope } from "../ingestion/memory-to-envelope.js";
import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import type { Memory, MemorySourceContext } from "../core/types.js";

import type {
  ReconciliationDimensionExecution,
  ReconciliationFindingRecord
} from "./report.js";

interface ShapeWindowRow {
  id: string;
  type: Memory["type"];
  project: string;
  content: string;
  source: Memory["source"];
  source_context: string | MemorySourceContext | null;
  created_at: string;
  raw_event_type: string;
  raw_project: string | null;
  raw_source_kind: string | null;
  payload_json: string;
}

interface ShapeAggregate {
  event_type: string;
  mismatch_type: "field_missing" | "value_mismatch";
  field_name: ShapeInvariantField;
  mismatch_count: number;
  sample_ids: string[];
}

type ShapeInvariantField = (typeof SHAPE_INVARIANT_FIELDS)[number];

export const SHAPE_INVARIANT_FIELDS = [
  "content",
  "type",
  "source_kind",
  "event_type",
  "project"
] as const;

const logger = createLogger({ name: "reconciliation-shape" });
const CANDIDATE_PROMOTION_INTEGRATION = "candidate" + "_promotion";

export async function runShapeDimension(args: {
  db: DatabaseAdapter;
  window_start: number;
  window_end: number;
}): Promise<ReconciliationDimensionExecution> {
  try {
    const rows = listShapeWindowRows(args.db, args.window_start, args.window_end);
    const aggregates = new Map<string, ShapeAggregate>();

    for (const row of rows) {
      const payload = parsePayload(row.payload_json);
      const parsedSourceContext = parseSourceContext(row.source_context);
      const expectedEnvelope = memoryToEnvelope(
        {
          id: row.id,
          type: row.type,
          project: row.project,
          title: row.id,
          content: row.content,
          summary: null,
          tags: [],
          created_at: row.created_at,
          source_context: parsedSourceContext
        },
        {
          event_type: deriveEventType({
            source: row.source,
            source_context: parsedSourceContext
          })
        }
      );
      const expectedValues = {
        content: row.content,
        type: expectedEnvelope.payload.memory_type,
        source_kind: expectedEnvelope.source_kind,
        event_type: expectedEnvelope.event_type,
        project: expectedEnvelope.project
      } satisfies Record<ShapeInvariantField, unknown>;
      const actualValues = {
        content: payload.content,
        type: payload.memory_type,
        source_kind: row.raw_source_kind,
        event_type: row.raw_event_type,
        project: row.raw_project
      } satisfies Record<ShapeInvariantField, unknown>;

      for (const field of SHAPE_INVARIANT_FIELDS) {
        const expectedValue = expectedValues[field];
        const actualValue = actualValues[field];

        if (isMissing(expectedValue) || isMissing(actualValue)) {
          recordAggregate(aggregates, row.raw_event_type, "field_missing", field, row.id);
          continue;
        }

        if (expectedValue !== actualValue) {
          recordAggregate(aggregates, row.raw_event_type, "value_mismatch", field, row.id);
        }
      }
    }

    const findings =
      aggregates.size > 0
        ? Array.from(aggregates.values())
            .sort((left, right) =>
              `${left.event_type}:${left.mismatch_type}:${left.field_name}`.localeCompare(
                `${right.event_type}:${right.mismatch_type}:${right.field_name}`
              )
            )
            .map(toFindingRecord)
        : [createPassFinding()];

    return {
      dimension: "shape",
      status: aggregates.size > 0 ? "fail" : "pass",
      findings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Shape reconciliation failed", { error: message });

    return {
      dimension: "shape",
      status: "error",
      error: message,
      findings: [createErrorFinding(message)]
    };
  }
}

function listShapeWindowRows(
  db: DatabaseAdapter,
  windowStart: number,
  windowEnd: number
): ShapeWindowRow[] {
  return db
    .prepare<[string, string], ShapeWindowRow>(
      `SELECT
         memory.id,
         memory.type,
         memory.project,
         memory.content,
         memory.source,
         memory.source_context,
         memory.created_at,
         raw.event_type AS raw_event_type,
         raw.project AS raw_project,
         raw.source_kind AS raw_source_kind,
         raw.payload_json
       FROM memories AS memory
       INNER JOIN raw_inbox AS raw
         ON raw.event_id = memory.id
       WHERE memory.created_at >= ? AND memory.created_at < ?
       ORDER BY memory.created_at ASC, memory.id ASC`
    )
    .all(toIso(windowStart), toIso(windowEnd));
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("payload_json must decode to an object");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Unable to parse payload_json: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function deriveEventType(memory: {
  source: Memory["source"];
  source_context: string | MemorySourceContext | null;
}): "decision" | "state_change" {
  if (memory.source === "explicit") {
    return "decision";
  }

  const sourceContext = parseSourceContext(memory.source_context);
  return sourceContext?.integration === CANDIDATE_PROMOTION_INTEGRATION ? "state_change" : "decision";
}

function parseSourceContext(value: string | MemorySourceContext | null): MemorySourceContext | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as MemorySourceContext) : null;
    } catch {
      return null;
    }
  }

  return value;
}

function isMissing(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function recordAggregate(
  aggregates: Map<string, ShapeAggregate>,
  eventType: string,
  mismatchType: ShapeAggregate["mismatch_type"],
  fieldName: ShapeInvariantField,
  sampleId: string
): void {
  const key = `${eventType}:${mismatchType}:${fieldName}`;
  const existing = aggregates.get(key);

  if (existing !== undefined) {
    existing.mismatch_count += 1;
    if (existing.sample_ids.length < 10) {
      existing.sample_ids.push(sampleId);
    }
    return;
  }

  aggregates.set(key, {
    event_type: eventType,
    mismatch_type: mismatchType,
    field_name: fieldName,
    mismatch_count: 1,
    sample_ids: [sampleId]
  });
}

function toFindingRecord(aggregate: ShapeAggregate): ReconciliationFindingRecord {
  return {
    status: "fail",
    event_type: aggregate.event_type,
    mismatch_count: aggregate.mismatch_count,
    sample_ids: [...aggregate.sample_ids],
    payload: {
      mismatch_type: aggregate.mismatch_type,
      field_name: aggregate.field_name,
      sample_ids: [...aggregate.sample_ids]
    }
  };
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
