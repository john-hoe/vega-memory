import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import { HOST_EVENT_ENVELOPE_V1 } from "../core/contracts/envelope.js";
import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { queryRawInbox, type RawInboxFilter } from "./raw-inbox.js";

export interface ReplayFilter extends RawInboxFilter {}

export interface ReplayOptions {
  classifier_version?: string;
  score_version?: string;
}

export interface ReplayedEvent {
  envelope: HostEventEnvelopeV1;
  received_at: string;
  replay_metadata: {
    replayed_at: string;
    classifier_version?: string;
    score_version?: string;
  };
}

const logger = createLogger({ name: "raw-inbox-replay" });

const parseJsonRecord = (value: string): Record<string, unknown> => {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected JSON object");
  }

  return parsed as Record<string, unknown>;
};

export function replayFromRawInbox(
  db: DatabaseAdapter,
  filter: ReplayFilter,
  options: ReplayOptions = {}
): ReplayedEvent[] {
  const rows = queryRawInbox(db, filter);
  const replayedAt = new Date().toISOString();
  const replayed: ReplayedEvent[] = [];

  for (const row of rows) {
    try {
      const envelope = {
        schema_version: row.schema_version,
        event_id: row.event_id,
        surface: row.surface,
        session_id: row.session_id,
        thread_id: row.thread_id,
        project: row.project,
        cwd: row.cwd,
        host_timestamp: row.host_timestamp,
        role: row.role,
        event_type: row.event_type,
        payload: parseJsonRecord(row.payload_json),
        safety: parseJsonRecord(row.safety_json),
        artifacts: []
      };
      const parsed = HOST_EVENT_ENVELOPE_V1.safeParse(envelope);

      if (!parsed.success) {
        logger.warn("Skipping invalid raw inbox row during replay", {
          event_id: row.event_id,
          issue: parsed.error.issues.map((issue) => issue.message).join("; ")
        });
        continue;
      }

      replayed.push({
        envelope: parsed.data,
        received_at: row.received_at,
        replay_metadata: {
          replayed_at: replayedAt,
          ...(options.classifier_version === undefined
            ? {}
            : { classifier_version: options.classifier_version }),
          ...(options.score_version === undefined
            ? {}
            : { score_version: options.score_version })
        }
      });
    } catch (error) {
      logger.warn("Skipping malformed raw inbox row during replay", {
        event_id: row.event_id,
        issue: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return replayed;
}
