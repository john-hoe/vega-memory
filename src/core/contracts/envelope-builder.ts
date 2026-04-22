import type { HostEventEnvelopeTransportV1, EnvelopeArtifact, EnvelopeSafety } from "./envelope.js";
import type { SourceKind } from "./enums.js";

export interface EnvelopeBuilderOptions {
  surface: string;
  session_id: string;
  role: string;
  event_type: string;
  thread_id?: string | null;
  project?: string | null;
  cwd?: string | null;
  source_kind?: SourceKind;
}

export interface EnvelopeBuilder {
  setPayload(payload: Record<string, unknown>): EnvelopeBuilder;
  setSafety(safety: EnvelopeSafety): EnvelopeBuilder;
  setArtifacts(artifacts: EnvelopeArtifact[]): EnvelopeBuilder;
  build(): HostEventEnvelopeTransportV1;
}

export function createEnvelopeBuilder(options: EnvelopeBuilderOptions): EnvelopeBuilder {
  let payload: Record<string, unknown> = {};
  let safety: EnvelopeSafety = { redacted: false, categories: [] };
  let artifacts: EnvelopeArtifact[] = [];

  return {
    setPayload(value: Record<string, unknown>): EnvelopeBuilder {
      payload = value;
      return this;
    },
    setSafety(value: EnvelopeSafety): EnvelopeBuilder {
      safety = value;
      return this;
    },
    setArtifacts(value: EnvelopeArtifact[]): EnvelopeBuilder {
      artifacts = value;
      return this;
    },
    build(): HostEventEnvelopeTransportV1 {
      return {
        schema_version: "1.0",
        event_id: crypto.randomUUID(),
        surface: options.surface,
        session_id: options.session_id,
        thread_id: options.thread_id ?? null,
        project: options.project ?? null,
        cwd: options.cwd ?? null,
        host_timestamp: new Date().toISOString(),
        role: options.role,
        event_type: options.event_type,
        payload,
        safety,
        artifacts,
        source_kind: options.source_kind
      };
    }
  };
}
