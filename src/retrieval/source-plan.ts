import { SOURCE_KINDS, type SourceKind } from "../core/contracts/enums.js";
import type { IntentRequest } from "../core/contracts/intent.js";

import type { IntentProfile } from "./profiles.js";

export interface SourcePlan {
  primary_sources: SourceKind[];
  fallback_sources: SourceKind[];
  focus: string | null;
  preferred_sources: SourceKind[];
}

const SOURCE_KIND_SET = new Set<string>(SOURCE_KINDS);
const HISTORY_SOURCES: SourceKind[] = ["vega_memory", "host_memory_file", "candidate"];
const DOCS_SOURCES: SourceKind[] = ["wiki", "fact_claim"];
const EVIDENCE_SOURCES: SourceKind[] = ["archive", "fact_claim", "graph"];

function uniqueSources(sources: SourceKind[]): SourceKind[] {
  return [...new Set(sources)];
}

function normalizeFocus(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length === 0 ? null : normalized;
}

function toSourceKinds(value: unknown): SourceKind[] {
  if (typeof value === "string") {
    return SOURCE_KIND_SET.has(value) ? [value as SourceKind] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is SourceKind => typeof entry === "string" && SOURCE_KIND_SET.has(entry))
    .map((entry) => entry as SourceKind);
}

function extractPreferredSources(host_hint: Record<string, unknown> | null): SourceKind[] {
  if (host_hint === null) {
    return [];
  }

  return uniqueSources([
    ...toSourceKinds(host_hint.source_kind),
    ...toSourceKinds(host_hint.source_kinds),
    ...toSourceKinds(host_hint.preferred_sources)
  ]);
}

function reorderSources(base: SourceKind[], preferred: SourceKind[]): SourceKind[] {
  const front = preferred.filter((kind) => base.includes(kind));
  const rest = base.filter((kind) => !front.includes(kind));
  return [...front, ...rest];
}

function mergeExtraPreferred(base: SourceKind[], preferred: SourceKind[]): SourceKind[] {
  const extra = preferred.filter((kind) => !base.includes(kind));
  return uniqueSources([...extra, ...base]);
}

function selectFocusedPrimarySources(
  profile: IntentProfile,
  request: IntentRequest,
  preferredSources: SourceKind[]
): SourceKind[] {
  const focus = normalizeFocus(request.query_focus);
  const defaults = [...profile.default_sources];

  if (focus === null || focus === "mixed") {
    return reorderSources(mergeExtraPreferred(defaults, preferredSources), preferredSources);
  }

  const focusedPool =
    focus === "history"
      ? HISTORY_SOURCES
      : focus === "docs"
        ? DOCS_SOURCES
        : focus === "evidence"
          ? EVIDENCE_SOURCES
          : defaults;

  const primary = uniqueSources([
    ...preferredSources.filter((kind) => focusedPool.includes(kind)),
    ...focusedPool.filter((kind) => defaults.includes(kind)),
    ...preferredSources.filter((kind) => !focusedPool.includes(kind))
  ]);

  return primary.length > 0
    ? reorderSources(primary, preferredSources)
    : reorderSources(mergeExtraPreferred(defaults, preferredSources), preferredSources);
}

export function createSourcePlan(
  profile: IntentProfile,
  request: IntentRequest
): SourcePlan {
  const focus = normalizeFocus(request.query_focus);
  const preferred_sources = extractPreferredSources(request.host_hint ?? null);
  const primary_sources = selectFocusedPrimarySources(profile, request, preferred_sources);
  const fallback_sources = profile.default_sources.filter((kind) => !primary_sources.includes(kind));

  return {
    primary_sources,
    fallback_sources,
    focus,
    preferred_sources
  };
}
