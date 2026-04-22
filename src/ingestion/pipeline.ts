import type { HostEventEnvelopeTransportV1 } from "../core/contracts/envelope.js";
import { createLogger } from "../core/logging/index.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import type { CandidateRepository, CandidateMemoryRecord } from "../db/candidate-repository.js";
import type { PromotionOrchestrator } from "../promotion/orchestrator.js";
import { envelopeToCandidateInput } from "./candidate-generator.js";
import { insertRawEvent } from "./raw-inbox.js";
import { normalizeEnvelope } from "./normalize-envelope.js";

export interface StageIngestEventResult {
  accepted_event_id: string;
  staged_in: "raw_inbox" | "deduped";
}

export interface StageIngestEventOptions {
  candidateRepository?: CandidateRepository;
  promotionOrchestrator?: PromotionOrchestrator;
  policyActor?: string;
}

const logger = createLogger({ name: "ingestion-pipeline" });

function findExistingCandidate(
  candidateRepository: CandidateRepository,
  envelope: HostEventEnvelopeTransportV1
): CandidateMemoryRecord | undefined {
  const generated = envelopeToCandidateInput(envelope);
  const { raw_dedup_key, semantic_fingerprint } = generated.input;

  if (raw_dedup_key) {
    const match = candidateRepository.findByRawDedupKey(raw_dedup_key);
    if (match !== undefined) {
      return match;
    }
  }

  if (semantic_fingerprint) {
    return candidateRepository.findBySemanticFingerprint(semantic_fingerprint);
  }

  return undefined;
}

function materializeCandidate(
  envelope: HostEventEnvelopeTransportV1,
  options: StageIngestEventOptions
): void {
  const candidateRepository = options.candidateRepository;
  if (candidateRepository === undefined) {
    return;
  }

  const generated = envelopeToCandidateInput(envelope);
  if (generated.input.content.trim().length === 0) {
    logger.info("Skipped candidate materialization because extracted content was empty", {
      event_id: envelope.event_id,
      skipped_reason: generated.skipped_reason ?? "empty-content"
    });
    return;
  }

  const existing = findExistingCandidate(candidateRepository, envelope);
  if (existing !== undefined) {
    logger.info("Deduped candidate materialization for ingest_event", {
      event_id: envelope.event_id,
      candidate_id: existing.id,
      raw_dedup_key: generated.input.raw_dedup_key,
      semantic_fingerprint: generated.input.semantic_fingerprint
    });
    return;
  }

  const candidate = candidateRepository.create({
    ...generated.input,
    source_kind: envelope.source_kind,
    metadata: {
      ...generated.input.metadata,
      source_event_id: envelope.event_id,
      source_surface: envelope.surface,
      source_role: envelope.role,
      source_event_type: envelope.event_type,
      source_session_id: envelope.session_id,
      source_thread_id: envelope.thread_id,
      source_project: envelope.project,
      source_cwd: envelope.cwd,
      source_host_timestamp: envelope.host_timestamp
    }
  });

  logger.info("Materialized ingest_event candidate", {
    event_id: envelope.event_id,
    candidate_id: candidate.id,
    candidate_type: candidate.type
  });

  if (options.promotionOrchestrator === undefined) {
    return;
  }

  const result = options.promotionOrchestrator.evaluateAndAct(
    candidate.id,
    "policy",
    options.policyActor ?? "ingest_event"
  );

  logger.info("Evaluated candidate via policy trigger during ingest_event", {
    event_id: envelope.event_id,
    candidate_id: candidate.id,
    promotion_status: result.status,
    reason: result.decision.reason
  });
}

export function stageIngestEvent(
  db: DatabaseAdapter,
  envelope: HostEventEnvelopeTransportV1,
  options: StageIngestEventOptions = {}
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
  } else {
    materializeCandidate(envelope, options);
  }

  return {
    accepted_event_id: result.event_id,
    staged_in: result.accepted ? "raw_inbox" : "deduped"
  };
}
