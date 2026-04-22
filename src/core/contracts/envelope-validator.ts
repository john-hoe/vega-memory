import { HOST_EVENT_ENVELOPE_TRANSPORT_V1 } from "./envelope.js";
import type { HostEventEnvelopeTransportV1 } from "./envelope.js";

export interface TransportValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateTransportEnvelope(input: unknown): TransportValidationResult {
  const result = HOST_EVENT_ENVELOPE_TRANSPORT_V1.safeParse(input);

  if (result.success) {
    return { valid: true, errors: [] };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });

  return { valid: false, errors };
}

export function isValidTransportEnvelope(input: unknown): input is HostEventEnvelopeTransportV1 {
  return HOST_EVENT_ENVELOPE_TRANSPORT_V1.safeParse(input).success;
}
