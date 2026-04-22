import { z } from "zod";

import { EVENT_TYPES, ROLES, SOURCE_KINDS, SURFACES } from "./enums.js";

export const ENVELOPE_ARTIFACT_SCHEMA = z.object({
  id: z.string(),
  kind: z.string(),
  uri: z.string().optional(),
  size_bytes: z.number().optional()
});

export const ENVELOPE_SAFETY_SCHEMA = z.object({
  redacted: z.boolean(),
  categories: z.array(z.string())
});

export const HOST_EVENT_ENVELOPE_TRANSPORT_V1 = z.object({
  schema_version: z.literal("1.0"),
  event_id: z.string().uuid(),
  surface: z.string(),
  session_id: z.string(),
  thread_id: z.string().nullable(),
  project: z.string().nullable(),
  cwd: z.string().nullable(),
  host_timestamp: z.string().datetime(),
  role: z.string(),
  event_type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  safety: ENVELOPE_SAFETY_SCHEMA,
  artifacts: z.array(ENVELOPE_ARTIFACT_SCHEMA),
  source_kind: z.enum(SOURCE_KINDS).optional()
});

export type HostEventEnvelopeTransportV1 = z.infer<typeof HOST_EVENT_ENVELOPE_TRANSPORT_V1>;

export const HOST_EVENT_ENVELOPE_V1 = z.object({
  schema_version: z.literal("1.0"),
  event_id: z.string().uuid(),
  surface: z.enum(SURFACES),
  session_id: z.string(),
  thread_id: z.string().nullable(),
  project: z.string().nullable(),
  cwd: z.string().nullable(),
  host_timestamp: z.string().datetime(),
  role: z.enum(ROLES),
  event_type: z.enum(EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
  safety: ENVELOPE_SAFETY_SCHEMA,
  artifacts: z.array(ENVELOPE_ARTIFACT_SCHEMA),
  source_kind: z.enum(SOURCE_KINDS).optional()
});

export type EnvelopeArtifact = z.infer<typeof ENVELOPE_ARTIFACT_SCHEMA>;
export type EnvelopeSafety = z.infer<typeof ENVELOPE_SAFETY_SCHEMA>;
export type HostEventEnvelopeV1 = z.infer<typeof HOST_EVENT_ENVELOPE_V1>;

export const parseEnvelope = (input: unknown): HostEventEnvelopeV1 =>
  HOST_EVENT_ENVELOPE_V1.parse(input);

export const safeParseEnvelope = (input: unknown) => HOST_EVENT_ENVELOPE_V1.safeParse(input);

export const parseTransportEnvelope = (input: unknown): HostEventEnvelopeTransportV1 =>
  HOST_EVENT_ENVELOPE_TRANSPORT_V1.parse(input);

export const safeParseTransportEnvelope = (input: unknown) =>
  HOST_EVENT_ENVELOPE_TRANSPORT_V1.safeParse(input);
