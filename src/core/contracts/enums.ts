export const SURFACES = ["claude", "codex", "cursor", "opencode", "hermes", "api", "cli"] as const;

export type Surface = (typeof SURFACES)[number];

export const ROLES = ["user", "assistant", "system", "tool"] as const;

export type Role = (typeof ROLES)[number];

export const EVENT_TYPES = ["message", "tool_call", "tool_result", "decision", "state_change"] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const SOURCE_KINDS = [
  "host_memory_file",
  "vega_memory",
  "candidate",
  "wiki",
  "fact_claim",
  "graph",
  "archive"
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export const INTENTS = ["bootstrap", "lookup", "followup", "evidence"] as const;

export type Intent = (typeof INTENTS)[number];

export const MODES = ["L0", "L1", "L2", "L3"] as const;

export type Mode = (typeof MODES)[number];

export const HOST_TIERS = ["T1", "T2", "T3"] as const;

export type HostTier = (typeof HOST_TIERS)[number];

export const SUFFICIENCY = ["sufficient", "needs_followup", "needs_external"] as const;

export type Sufficiency = (typeof SUFFICIENCY)[number];
