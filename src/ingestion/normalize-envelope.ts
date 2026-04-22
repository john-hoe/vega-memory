import { EVENT_TYPES, ROLES, SURFACES } from "../core/contracts/enums.js";
import type { HostEventEnvelopeTransportV1 } from "../core/contracts/envelope.js";

export interface NormalizedEnvelope {
  surface: (typeof SURFACES)[number];
  role: (typeof ROLES)[number];
  event_type: (typeof EVENT_TYPES)[number];
  warnings: string[];
}

export function normalizeEnvelope(
  envelope: HostEventEnvelopeTransportV1
): NormalizedEnvelope {
  const warnings: string[] = [];

  const normalizedSurface = SURFACES.includes(envelope.surface as (typeof SURFACES)[number])
    ? (envelope.surface as (typeof SURFACES)[number])
    : "unknown";

  if (normalizedSurface === "unknown") {
    warnings.push(`Unknown surface "${envelope.surface}"; falling back to "unknown"`);
  }

  const normalizedRole = ROLES.includes(envelope.role as (typeof ROLES)[number])
    ? (envelope.role as (typeof ROLES)[number])
    : "unknown";

  if (normalizedRole === "unknown") {
    warnings.push(`Unknown role "${envelope.role}"; falling back to "unknown"`);
  }

  const normalizedEventType = EVENT_TYPES.includes(envelope.event_type as (typeof EVENT_TYPES)[number])
    ? (envelope.event_type as (typeof EVENT_TYPES)[number])
    : "unknown";

  if (normalizedEventType === "unknown") {
    warnings.push(`Unknown event_type "${envelope.event_type}"; falling back to "unknown"`);
  }

  return {
    surface: normalizedSurface,
    role: normalizedRole,
    event_type: normalizedEventType,
    warnings
  };
}
