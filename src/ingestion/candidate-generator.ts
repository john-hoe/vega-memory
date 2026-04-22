import type { HostEventEnvelopeTransportV1 } from "../core/contracts/envelope.js";
import type { CandidateMemoryCreateInput } from "../db/candidate-repository.js";
import {
  extractFromDecisionPayload,
  extractFromMessagePayload,
  extractFromStateChangePayload,
  extractFromToolCallPayload,
  extractFromToolResultPayload
} from "./candidate-extractor.js";

export interface CandidateGenerationResult {
  input: CandidateMemoryCreateInput;
  skipped_reason?: string;
}

const EVENT_TYPE_MAP: Record<string, (payload: Record<string, unknown>) => { content: string; type: string; project: string | null; raw_dedup_key: string; semantic_fingerprint: string }> = {
  message: extractFromMessagePayload,
  tool_result: extractFromToolResultPayload,
  decision: extractFromDecisionPayload,
  state_change: extractFromStateChangePayload,
  tool_call: extractFromToolCallPayload
};

export function envelopeToCandidateInput(
  envelope: HostEventEnvelopeTransportV1
): CandidateGenerationResult {
  const extractor = EVENT_TYPE_MAP[envelope.event_type];

  if (extractor === undefined) {
    return {
      input: {
        content: JSON.stringify(envelope.payload),
        type: "unknown",
        project: envelope.project,
        extraction_source: `surface:${envelope.surface};event_type:${envelope.event_type}`,
        raw_dedup_key: null,
        semantic_fingerprint: null
      },
      skipped_reason: `No extractor for event_type "${envelope.event_type}"; falling back to raw JSON content with no dedup key`
    };
  }

  const extracted = extractor(envelope.payload);

  if (extracted.content.length === 0) {
    return {
      input: {
        content: "",
        type: extracted.type,
        project: extracted.project ?? envelope.project,
        extraction_source: `surface:${envelope.surface};event_type:${envelope.event_type}`,
        raw_dedup_key: null,
        semantic_fingerprint: null
      },
      skipped_reason: "Empty content after extraction; no dedup key generated"
    };
  }

  return {
    input: {
      content: extracted.content,
      type: extracted.type,
      project: extracted.project ?? envelope.project,
      extraction_source: `surface:${envelope.surface};event_type:${envelope.event_type}`,
      raw_dedup_key: extracted.raw_dedup_key,
      semantic_fingerprint: extracted.semantic_fingerprint
    }
  };
}
