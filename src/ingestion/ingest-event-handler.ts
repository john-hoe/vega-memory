import type { Request, Response } from "express";

import {
  HOST_EVENT_ENVELOPE_TRANSPORT_V1,
  type HostEventEnvelopeTransportV1
} from "../core/contracts/envelope.js";
import { SOURCE_KINDS } from "../core/contracts/enums.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { stageIngestEvent, type StageIngestEventResult } from "./pipeline.js";

export interface IngestEventResponse {
  accepted_event_id: string;
  staged_in: "raw_inbox" | "deduped";
}

export interface IngestEventMcpTool {
  name: "ingest_event";
  description: string;
  inputSchema: object;
  invoke(envelope: unknown): Promise<IngestEventResponse>;
}

const ENVELOPE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { type: "string", const: "1.0" },
    event_id: { type: "string", format: "uuid" },
    surface: { type: "string" },
    session_id: { type: "string" },
    thread_id: { type: ["string", "null"] },
    project: { type: ["string", "null"] },
    cwd: { type: ["string", "null"] },
    host_timestamp: { type: "string", format: "date-time" },
    role: { type: "string" },
    event_type: { type: "string" },
    payload: {
      type: "object",
      additionalProperties: true
    },
    safety: {
      type: "object",
      additionalProperties: false,
      properties: {
        redacted: { type: "boolean" },
        categories: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["redacted", "categories"]
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          kind: { type: "string" },
          uri: { type: "string" },
          size_bytes: { type: "number" }
        },
        required: ["id", "kind"]
      }
    },
    source_kind: { type: "string", enum: [...SOURCE_KINDS] }
  },
  required: [
    "schema_version",
    "event_id",
    "surface",
    "session_id",
    "thread_id",
    "project",
    "cwd",
    "host_timestamp",
    "role",
    "event_type",
    "payload",
    "safety",
    "artifacts"
  ]
} as const satisfies object;

const formatValidationDetail = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "root" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export function createIngestEventHttpHandler(
  db: DatabaseAdapter
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = HOST_EVENT_ENVELOPE_TRANSPORT_V1.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: "ValidationError",
          detail: formatValidationDetail(parsed.error.issues)
        });
        return;
      }

      res.status(200).json(stageIngestEvent(db, parsed.data));
    } catch {
      res.status(500).json({ error: "InternalError" });
    }
  };
}

export function createIngestEventMcpTool(db: DatabaseAdapter): IngestEventMcpTool {
  return {
    name: "ingest_event",
    description: "Stages a Host Event Envelope v1 into raw_inbox with idempotent dedupe semantics.",
    inputSchema: ENVELOPE_INPUT_SCHEMA,
    async invoke(envelope: unknown): Promise<IngestEventResponse> {
      const parsed = HOST_EVENT_ENVELOPE_TRANSPORT_V1.parse(envelope);
      return stageIngestEvent(db, parsed);
    }
  };
}
