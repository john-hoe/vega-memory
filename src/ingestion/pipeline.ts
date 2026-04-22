import type { HostEventEnvelopeTransportV1 } from "../core/contracts/envelope.js";
import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { insertRawEvent, type InsertResult } from "./raw-inbox.js";
import { normalizeEnvelope } from "./normalize-envelope.js";

export interface StageIngestEventResult {
  accepted_event_id: string;
  staged_in: "raw_inbox" | "deduped";
}

const logger = createLogger({ name: "ingestion-pipeline" });

export function stageIngestEvent(
  db: DatabaseAdapter,
  envelope: HostEventEnvelopeTransportV1
): StageIngestEventResult {
  const normalized = normalizeEnvelope(envelope);

  for (const warning of normalized.warnings) {
    logger.warn(warning, {
      event_id: envelope.event_id,
      surface: envelope.surface,
      role: envelope.role,
      event_type: envelope.event_type
    });
  }

  const result = insertRawEvent(db, envelope);

  if (!result.accepted) {
    logger.info("Deduped ingest_event envelope", {
      event_id: result.event_id,
      surface: envelope.surface,
      session_id: envelope.session_id
    });
  }

  return {
    accepted_event_id: result.event_id,
    staged_in: result.accepted ? "raw_inbox" : "deduped"
  };
}
