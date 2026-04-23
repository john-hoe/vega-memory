import type { Request, Response } from "express";
import { z } from "zod";

import type { DatabaseAdapter } from "../db/adapter.js";
import type { VegaMetricsRegistry } from "../monitoring/vega-metrics.js";

export const FEEDBACK_USAGE_ACK_TYPES = ["accepted", "rejected", "reranked"] as const;
export type FeedbackUsageAckType = (typeof FEEDBACK_USAGE_ACK_TYPES)[number];

export const FEEDBACK_USAGE_ACK_SCHEMA = z.object({
  memory_id: z.string().trim().min(1),
  ack_type: z.enum(FEEDBACK_USAGE_ACK_TYPES),
  context: z.record(z.string(), z.unknown()),
  session_id: z.string().trim().min(1),
  event_id: z.string().uuid(),
  ts: z.string().datetime()
});

export type FeedbackUsageAck = z.infer<typeof FEEDBACK_USAGE_ACK_SCHEMA>;

export interface FeedbackUsageAckRecord extends FeedbackUsageAck {
  ingested_at: number;
}

export interface FeedbackUsageAckCounters {
  accepted: number;
  rejected: number;
  reranked: number;
  total: number;
}

export type FeedbackUsageAckDegradedReason = "usage_feedback_ack_unavailable";

export interface FeedbackUsageAckPutResult {
  record: FeedbackUsageAckRecord;
  status: "inserted" | "idempotent";
}

export interface FeedbackUsageAckStore {
  put(ack: FeedbackUsageAck): FeedbackUsageAckPutResult;
  getByEventId(event_id: string): FeedbackUsageAckRecord | undefined;
  countByMemory(memory_id: string): FeedbackUsageAckCounters;
  size(): number;
}

export interface FeedbackUsageAckStoreOptions {
  now?: () => number;
}

export interface FeedbackUsageAckResponse {
  ack: true;
  event_id: string;
  memory_id: string;
  idempotent: boolean;
  counters: FeedbackUsageAckCounters;
  bounded_surfaces: ["retrieval_prior", "ranking_bias", "value_judgment_stats"];
  degraded?: FeedbackUsageAckDegradedReason;
}

export interface FeedbackUsageAckMcpTool {
  name: "usage.ack";
  description: string;
  inputSchema: object;
  invoke(request: unknown): Promise<FeedbackUsageAckResponse>;
}

interface FeedbackUsageAckRow {
  event_id: string;
  memory_id: string;
  ack_type: FeedbackUsageAckType;
  context_json: string;
  session_id: string;
  ts: string;
  ingested_at: number;
}

interface CountRow {
  ack_type: FeedbackUsageAckType;
  count: number;
}

export const FEEDBACK_USAGE_ACKS_TABLE = "feedback_usage_acks";

const BOUNDED_SURFACES: FeedbackUsageAckResponse["bounded_surfaces"] = [
  "retrieval_prior",
  "ranking_bias",
  "value_judgment_stats"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeZodJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeZodJsonSchema(entry));
  }

  if (!isRecord(schema)) {
    return schema;
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === false) {
      continue;
    }

    normalized[key] = normalizeZodJsonSchema(value);
  }

  return normalized;
}

function createFeedbackUsageAckInputSchema(): object {
  const generated = normalizeZodJsonSchema(z.toJSONSchema(FEEDBACK_USAGE_ACK_SCHEMA));
  return isRecord(generated) ? generated : {};
}

export const FEEDBACK_USAGE_ACK_INPUT_SCHEMA = createFeedbackUsageAckInputSchema();

const FEEDBACK_USAGE_ACK_DDL = `
  CREATE TABLE IF NOT EXISTS ${FEEDBACK_USAGE_ACKS_TABLE} (
    event_id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    ack_type TEXT NOT NULL,
    context_json TEXT NOT NULL,
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    ingested_at INTEGER NOT NULL
  )
`;

const FEEDBACK_USAGE_ACK_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_feedback_usage_acks_memory ON ${FEEDBACK_USAGE_ACKS_TABLE}(memory_id, ack_type)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_usage_acks_session ON ${FEEDBACK_USAGE_ACKS_TABLE}(session_id, ts DESC)`
] as const;

export function applyFeedbackUsageAckStoreMigration(db: DatabaseAdapter): void {
  db.exec(FEEDBACK_USAGE_ACK_DDL);
  for (const statement of FEEDBACK_USAGE_ACK_INDEXES) {
    db.exec(statement);
  }
}

function toRecord(row: FeedbackUsageAckRow): FeedbackUsageAckRecord {
  const context = JSON.parse(row.context_json) as Record<string, unknown>;
  return {
    event_id: row.event_id,
    memory_id: row.memory_id,
    ack_type: row.ack_type,
    context,
    session_id: row.session_id,
    ts: row.ts,
    ingested_at: row.ingested_at
  };
}

const emptyCounters = (): FeedbackUsageAckCounters => ({
  accepted: 0,
  rejected: 0,
  reranked: 0,
  total: 0
});

export function createFeedbackUsageAckStore(
  db: DatabaseAdapter,
  options: FeedbackUsageAckStoreOptions = {}
): FeedbackUsageAckStore {
  applyFeedbackUsageAckStoreMigration(db);

  const now = options.now ?? (() => Date.now());
  const insertStatement = db.prepare<
    [string, string, FeedbackUsageAckType, string, string, string, number],
    never
  >(
    `INSERT INTO ${FEEDBACK_USAGE_ACKS_TABLE} (
      event_id,
      memory_id,
      ack_type,
      context_json,
      session_id,
      ts,
      ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const getStatement = db.prepare<[string], FeedbackUsageAckRow>(
    `SELECT event_id, memory_id, ack_type, context_json, session_id, ts, ingested_at
     FROM ${FEEDBACK_USAGE_ACKS_TABLE}
     WHERE event_id = ?`
  );
  const countByMemoryStatement = db.prepare<[string], CountRow>(
    `SELECT ack_type, COUNT(*) AS count
     FROM ${FEEDBACK_USAGE_ACKS_TABLE}
     WHERE memory_id = ?
     GROUP BY ack_type`
  );

  return {
    put(ack: FeedbackUsageAck): FeedbackUsageAckPutResult {
      return db.transaction(() => {
        const existing = getStatement.get(ack.event_id);
        if (existing !== undefined) {
          return {
            record: toRecord(existing),
            status: "idempotent"
          } satisfies FeedbackUsageAckPutResult;
        }

        const stored: FeedbackUsageAckRecord = {
          ...ack,
          ingested_at: now()
        };

        insertStatement.run(
          stored.event_id,
          stored.memory_id,
          stored.ack_type,
          JSON.stringify(stored.context),
          stored.session_id,
          stored.ts,
          stored.ingested_at
        );

        return {
          record: stored,
          status: "inserted"
        } satisfies FeedbackUsageAckPutResult;
      });
    },
    getByEventId(event_id: string): FeedbackUsageAckRecord | undefined {
      const row = getStatement.get(event_id);
      return row === undefined ? undefined : toRecord(row);
    },
    countByMemory(memory_id: string): FeedbackUsageAckCounters {
      const counters = emptyCounters();
      for (const row of countByMemoryStatement.all(memory_id)) {
        counters[row.ack_type] = row.count;
        counters.total += row.count;
      }
      return counters;
    },
    size(): number {
      return db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${FEEDBACK_USAGE_ACKS_TABLE}`
      )?.count ?? 0;
    }
  };
}

function formatValidationDetail(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "root" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function processFeedbackUsageAck(
  ack: FeedbackUsageAck,
  store: FeedbackUsageAckStore | undefined,
  metrics?: VegaMetricsRegistry
): FeedbackUsageAckResponse {
  if (store === undefined) {
    metrics?.recordUsageFeedbackAckRejected("usage_feedback_ack_unavailable");
    return {
      ack: true,
      event_id: ack.event_id,
      memory_id: ack.memory_id,
      idempotent: false,
      counters: emptyCounters(),
      bounded_surfaces: BOUNDED_SURFACES,
      degraded: "usage_feedback_ack_unavailable"
    };
  }

  const putResult = store.put(ack);
  const counters = store.countByMemory(putResult.record.memory_id);
  if (putResult.status === "inserted") {
    metrics?.recordUsageFeedbackAck(putResult.record.ack_type);
  }

  return {
    ack: true,
    event_id: putResult.record.event_id,
    memory_id: putResult.record.memory_id,
    idempotent: putResult.status === "idempotent",
    counters,
    bounded_surfaces: BOUNDED_SURFACES
  };
}

export function isFeedbackUsageAckRequest(request: unknown): boolean {
  return typeof request === "object" &&
    request !== null &&
    ("memory_id" in request || "ack_type" in request || "event_id" in request);
}

export function createFeedbackUsageAckMcpTool(
  store: FeedbackUsageAckStore | undefined,
  metrics?: VegaMetricsRegistry
): FeedbackUsageAckMcpTool {
  return {
    name: "usage.ack",
    description: "Stores bounded per-memory usage feedback without allowing hosts to rewrite memory state.",
    inputSchema: FEEDBACK_USAGE_ACK_INPUT_SCHEMA,
    async invoke(request: unknown): Promise<FeedbackUsageAckResponse> {
      const parsed = FEEDBACK_USAGE_ACK_SCHEMA.safeParse(request);
      if (!parsed.success) {
        metrics?.recordUsageFeedbackAckRejected("validation_error");
        throw parsed.error;
      }

      return processFeedbackUsageAck(parsed.data, store, metrics);
    }
  };
}

export function createFeedbackUsageAckHttpHandler(
  store: FeedbackUsageAckStore | undefined,
  metrics?: VegaMetricsRegistry
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = FEEDBACK_USAGE_ACK_SCHEMA.safeParse(req.body);

    if (!parsed.success) {
      metrics?.recordUsageFeedbackAckRejected("validation_error");
      res.status(400).json({
        error: "ValidationError",
        detail: formatValidationDetail(parsed.error.issues)
      });
      return;
    }

    res.status(200).json(processFeedbackUsageAck(parsed.data, store, metrics));
  };
}
