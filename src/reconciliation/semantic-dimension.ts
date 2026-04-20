import { createHash } from "node:crypto";

import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";

import type {
  ReconciliationDimensionExecution,
  ReconciliationFindingRecord
} from "./report.js";

interface SemanticWindowRow {
  id: string;
  content: string;
  raw_event_type: string;
  semantic_payload_json: string;
}

const DEFAULT_SAMPLE_SIZE = 50;
const logger = createLogger({ name: "reconciliation-semantic" });

export async function runSemanticDimension(args: {
  db: DatabaseAdapter;
  window_start: number;
  window_end: number;
  semantic_sample_size?: number;
}): Promise<ReconciliationDimensionExecution> {
  try {
    const rows = listSemanticWindowRows(args.db, args.window_start, args.window_end);
    const sampleSize = resolveSampleSize(args.semantic_sample_size);
    const sampledRows = sampleRows(rows, sampleSize);
    const mismatches: Array<{
      event_type: string;
      sample_id: string;
      memory_content_snippet: string;
      envelope_content_snippet: string;
    }> = [];

    for (const row of sampledRows) {
      const payload = parsePayload(row.semantic_payload_json);
      const envelopeContent = payload.content;

      if (typeof envelopeContent !== "string") {
        throw new Error("payload_json.content must be a string");
      }

      if (hashContent(row.content) !== hashContent(envelopeContent)) {
        mismatches.push({
          event_type: row.raw_event_type,
          sample_id: row.id,
          memory_content_snippet: toSnippet(row.content),
          envelope_content_snippet: toSnippet(envelopeContent)
        });
      }
    }

    const findings =
      mismatches.length > 0
        ? buildMismatchFindings(mismatches)
        : [createPassFinding()];

    return {
      dimension: "semantic",
      status: mismatches.length > 0 ? "fail" : "pass",
      findings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Semantic reconciliation failed", { error: message });

    return {
      dimension: "semantic",
      status: "error",
      error: message,
      findings: [createErrorFinding(message)]
    };
  }
}

function listSemanticWindowRows(
  db: DatabaseAdapter,
  windowStart: number,
  windowEnd: number
): SemanticWindowRow[] {
  return db
    .prepare<[string, string], SemanticWindowRow>(
      `SELECT
         memory.id,
         memory.content,
         raw.event_type AS raw_event_type,
         raw.payload_json AS semantic_payload_json
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

function resolveSampleSize(value?: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  const parsed = Number.parseInt(process.env.VEGA_RECONCILIATION_SEMANTIC_SAMPLE_SIZE ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_SIZE;
}

function sampleRows<T>(rows: T[], sampleSize: number): T[] {
  if (sampleSize >= rows.length) {
    return [...rows];
  }

  const copy = [...rows];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex]!, copy[index]!];
  }

  return copy.slice(0, sampleSize);
}

function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildMismatchFindings(
  mismatches: Array<{
    event_type: string;
    sample_id: string;
    memory_content_snippet: string;
    envelope_content_snippet: string;
  }>
): ReconciliationFindingRecord[] {
  const aggregates = new Map<
    string,
    {
      event_type: string;
      mismatch_count: number;
      sample_ids: string[];
      memory_content_snippet: string;
      envelope_content_snippet: string;
    }
  >();

  for (const mismatch of mismatches) {
    const existing = aggregates.get(mismatch.event_type);
    if (existing !== undefined) {
      existing.mismatch_count += 1;
      if (existing.sample_ids.length < 10) {
        existing.sample_ids.push(mismatch.sample_id);
      }
      continue;
    }

    aggregates.set(mismatch.event_type, {
      event_type: mismatch.event_type,
      mismatch_count: 1,
      sample_ids: [mismatch.sample_id],
      memory_content_snippet: mismatch.memory_content_snippet,
      envelope_content_snippet: mismatch.envelope_content_snippet
    });
  }

  return Array.from(aggregates.values())
    .sort((left, right) => left.event_type.localeCompare(right.event_type))
    .map((aggregate) => ({
      status: "fail",
      event_type: aggregate.event_type,
      mismatch_count: aggregate.mismatch_count,
      sample_ids: [...aggregate.sample_ids],
      payload: {
        mismatch_type: "content_hash_mismatch",
        sample_ids: [...aggregate.sample_ids],
        memory_content_snippet: aggregate.memory_content_snippet,
        envelope_content_snippet: aggregate.envelope_content_snippet
      }
    }));
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

function toSnippet(value: string): string {
  return value.slice(0, 100);
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
