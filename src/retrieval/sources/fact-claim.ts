import { FactClaimService } from "../../core/fact-claim-service.js";
import type { FactClaim } from "../../core/types.js";

import type { SourceAdapter, SourceRecord, SourceSearchInput } from "./types.js";

const now = (): string => new Date().toISOString();

const tokenize = (value: string): string[] =>
  value
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((part) => part.length > 0);

const claimHaystack = (claim: FactClaim): string =>
  [
    claim.subject,
    claim.predicate,
    claim.claim_value,
    claim.claim_text,
    claim.canonical_key
  ]
    .join("\n")
    .toLowerCase();

function listRecent(
  service: FactClaimService,
  input: SourceSearchInput,
  project: string
): SourceRecord[] {
  return service
    .listClaims(project, "active")
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, input.top_k)
    .map(
      (claim): SourceRecord => ({
        id: claim.id,
        source_kind: "fact_claim",
        content: claim.claim_text,
        created_at: claim.created_at,
        provenance: {
          origin: `fact_claim:${claim.id}`,
          retrieved_at: now()
        },
        raw_score: claim.confidence,
        metadata: {
          canonical_key: claim.canonical_key,
          subject: claim.subject,
          predicate: claim.predicate,
          claim_value: claim.claim_value,
          valid_from: claim.valid_from,
          valid_to: claim.valid_to,
          temporal_precision: claim.temporal_precision,
          source_memory_id: claim.source_memory_id,
          evidence_archive_id: claim.evidence_archive_id
        }
      })
    );
}

export function createFactClaimSource(service: FactClaimService): SourceAdapter {
  return {
    kind: "fact_claim",
    name: "fact-claim",
    enabled: true,
    search(input) {
      const query = input.request.query?.trim() ?? "";
      const project = input.request.project;
      const profile = input.request.intent;

      if (query.length === 0) {
        if (profile === "bootstrap" && project !== null) {
          return listRecent(service, input, project);
        }

        return [];
      }

      if (project === null) {
        return [];
      }

      const terms = tokenize(query);

      return service
        .listClaims(project, "active")
        .filter((claim) => {
          const haystack = claimHaystack(claim);
          return terms.every((term) => haystack.includes(term));
        })
        .slice(0, input.top_k)
        .map(
          (claim): SourceRecord => ({
            id: claim.id,
            source_kind: "fact_claim",
            content: claim.claim_text,
            created_at: claim.created_at,
            provenance: {
              origin: `fact_claim:${claim.id}`,
              retrieved_at: now()
            },
            raw_score: claim.confidence,
            metadata: {
              canonical_key: claim.canonical_key,
              subject: claim.subject,
              predicate: claim.predicate,
              claim_value: claim.claim_value,
              valid_from: claim.valid_from,
              valid_to: claim.valid_to,
              temporal_precision: claim.temporal_precision,
              source_memory_id: claim.source_memory_id,
              evidence_archive_id: claim.evidence_archive_id
            }
          })
        );
    }
  };
}
