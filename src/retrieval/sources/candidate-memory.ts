import type { CandidateRepository } from "../../db/candidate-repository.js";
import { readFeatureFlag } from "../../ingestion/feature-flags.js";
import type { SourceAdapter, SourceRecord, SourceSearchInput } from "./types.js";

export function createCandidateMemorySource(): SourceAdapter {
  return {
    kind: "candidate",
    name: "candidate-memory (pending Wave 4)",
    enabled: false,
    search() {
      return [];
    }
  };
}

export interface CandidateMemoryAdapterOptions {
  repository: CandidateRepository;
  visibilityEnabled?: boolean;
}

const now = (): string => new Date().toISOString();

export function createCandidateMemoryAdapter(
  options: CandidateMemoryAdapterOptions
): SourceAdapter {
  return {
    kind: "candidate",
    name: "candidate-memory",
    enabled: true,
    search(input: SourceSearchInput): SourceRecord[] {
      const visibilityEnabled =
        options.visibilityEnabled ??
        readFeatureFlag("VEGA_CANDIDATE_VISIBILITY_ENABLED");

      if (!visibilityEnabled) {
        return [];
      }

      // Push visibility_gated filter into the SQL WHERE clause so LIMIT applies
      // AFTER the filter. Filtering post-fetch truncated visible rows whenever
      // gated=true rows happened to sort earlier (review round-6 #1).
      return options.repository
        .list({
          project: input.request.project ?? undefined,
          limit: input.top_k * 4,
          visibility_gated: false
        })
        .filter((record) => record.candidate_state !== "discarded")
        .slice(0, input.top_k)
        .map((record): SourceRecord => ({
          id: record.id,
          source_kind: "candidate",
          content: record.content,
          provenance: {
            origin: `candidate_memory:${record.id}`,
            retrieved_at: now()
          },
          raw_score: 0.5,
          metadata: {
            type: record.type,
            project: record.project,
            extraction_source: record.extraction_source,
            extraction_confidence: record.extraction_confidence,
            promotion_score: record.promotion_score,
            visibility_gated: record.visibility_gated,
            candidate_state: record.candidate_state,
            tags: record.tags
          }
        }));
    }
  };
}
