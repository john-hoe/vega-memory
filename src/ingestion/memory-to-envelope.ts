import { v5 as uuidv5, validate as isUuid } from "uuid";

import { SURFACES } from "../core/contracts/enums.js";
import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import { createLogger } from "../core/logging/index.js";
import type { Memory, MemorySourceContext } from "../core/types.js";

export interface MemoryToEnvelopeOptions {
  default_surface?: string;
  event_type?: string;
  force_event_id?: string;
}

export interface LegacyMemoryEnvelopeSource {
  id: string;
  type: string;
  project: string | null;
  title: string;
  content: string;
  summary: string | null;
  tags: string;
  created_at: string;
  source_context: string | null;
}

interface ParsedSourceContext {
  session_id?: string;
  surface?: string;
}

export const VEGA_BACKFILL_NAMESPACE = "7e6d9c8a-1b2c-4d3e-8f5a-0b1c2d3e4f5a";
const logger = createLogger({ name: "memory-to-envelope" });
const CANONICAL_SURFACES = new Set<string>(SURFACES);

const parseJson = (value: string | unknown[]): unknown => {
  if (Array.isArray(value)) {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const parseSourceContext = (
  value: MemorySourceContext | string | null | undefined
): ParsedSourceContext | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        return null;
      }

      return parsed as ParsedSourceContext;
    } catch {
      return null;
    }
  }

  return value;
};

const deriveEventId = (memory: Pick<Memory, "id" | "created_at">): string => {
  if (isUuid(memory.id)) {
    return memory.id;
  }

  return uuidv5(`${memory.id}:${memory.created_at}`, VEGA_BACKFILL_NAMESPACE);
};

type MemoryEnvelopeSource =
  | Pick<
      Memory,
      "id" | "type" | "project" | "title" | "content" | "summary" | "tags" | "created_at" | "source_context"
    >
  | LegacyMemoryEnvelopeSource;

const resolveSurface = (
  memory: Pick<MemoryEnvelopeSource, "id" | "source_context">,
  defaultSurface: HostEventEnvelopeV1["surface"]
): HostEventEnvelopeV1["surface"] => {
  const sourceContext = parseSourceContext(memory.source_context);
  const surface = sourceContext?.surface;

  if (surface === undefined) {
    return defaultSurface;
  }

  if (CANONICAL_SURFACES.has(surface)) {
    return surface as HostEventEnvelopeV1["surface"];
  }

  logger.warn("Invalid source_context surface on memory envelope", {
    memory_id: memory.id,
    surface
  });
  return defaultSurface;
};

export function memoryToEnvelope(
  memory: Pick<
    Memory,
    "id" | "type" | "project" | "title" | "content" | "summary" | "tags" | "created_at" | "source_context"
  >,
  options?: MemoryToEnvelopeOptions
): HostEventEnvelopeV1;
export function memoryToEnvelope(
  memory: LegacyMemoryEnvelopeSource,
  options?: MemoryToEnvelopeOptions
): HostEventEnvelopeV1;
export function memoryToEnvelope(
  memory: MemoryEnvelopeSource,
  options: MemoryToEnvelopeOptions = {}
): HostEventEnvelopeV1 {
  const sourceContext = parseSourceContext(memory.source_context);
  const defaultSurface = (options.default_surface ?? "api") as HostEventEnvelopeV1["surface"];

  return {
    schema_version: "1.0",
    event_id: options.force_event_id ?? deriveEventId(memory),
    surface: resolveSurface(memory, defaultSurface),
    session_id: sourceContext?.session_id ?? `legacy-${memory.id}`,
    thread_id: null,
    project: memory.project ?? null,
    cwd: null,
    host_timestamp: memory.created_at,
    role: "system",
    event_type: (options.event_type ?? "decision") as HostEventEnvelopeV1["event_type"],
    payload: {
      memory_type: memory.type,
      title: memory.title,
      content: memory.content,
      summary: memory.summary,
      tags: parseJson(memory.tags)
    },
    safety: {
      redacted: false,
      categories: []
    },
    artifacts: [],
    source_kind: "vega_memory"
  };
}
