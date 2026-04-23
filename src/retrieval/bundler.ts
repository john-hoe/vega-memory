import type { Bundle, BundleRecord, BundleSection } from "../core/contracts/bundle.js";
import { BUNDLE_SCHEMA } from "../core/contracts/bundle.js";
import { createLogger } from "../core/logging/index.js";

import type { BudgetedRecord } from "./budget.js";
import { createBundleDigest } from "./bundler-digest.js";

export interface BundleAssembly {
  bundle: Bundle;
  bundle_digest: string;
  truncated_count: number;
  total_tokens: number;
}

const logger = createLogger({
  name: "retrieval-bundler",
  minLevel: "error"
});

function toBundleRecord(entry: BudgetedRecord): BundleRecord {
  return {
    id: entry.record.id,
    record_id: entry.record.id,
    source_kind: entry.record.source_kind,
    content: entry.content_used,
    provenance: entry.record.provenance,
    score: entry.record.final_score
  };
}

function buildSections(budgeted: BudgetedRecord[]): BundleSection[] {
  const grouped = new Map<string, BundleRecord[]>();

  for (const entry of budgeted) {
    const records = grouped.get(entry.record.source_kind) ?? [];
    records.push(toBundleRecord(entry));
    grouped.set(entry.record.source_kind, records);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source_kind, records]) => ({
      kind: source_kind,
      title: source_kind,
      source_kind: source_kind as BundleSection["source_kind"],
      records: records.sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    }));
}

export function assembleBundle(
  checkpoint_id: string,
  budgeted: BudgetedRecord[],
  truncated_count: number,
  total_tokens: number,
  fallback_used = false,
  confidence = 0.0,
  warnings: string[] = [],
  next_retrieval_hint = "none"
): BundleAssembly {
  const sections = buildSections(budgeted);
  const used_sources = [...new Set(budgeted.map((entry) => entry.record.source_kind))];
  const bundle_digest = createBundleDigest({
    schema_version: "1.0",
    checkpoint_id,
    bundle_digest: "",
    sections,
    used_sources,
    fallback_used,
    confidence,
    warnings,
    next_retrieval_hint
  });
  const bundle = BUNDLE_SCHEMA.parse({
    schema_version: "1.0",
    checkpoint_id,
    bundle_digest,
    sections,
    used_sources,
    fallback_used,
    confidence,
    warnings,
    next_retrieval_hint
  });

  logger.debug("Assembled retrieval bundle", {
    section_count: sections.length,
    truncated_count,
    total_tokens
  });

  return {
    bundle,
    bundle_digest,
    truncated_count,
    total_tokens
  };
}
