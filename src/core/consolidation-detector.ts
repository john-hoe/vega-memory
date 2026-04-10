import type { Repository } from "../db/repository.js";
import type { ConsolidationCandidate, ConsolidationCandidateKind } from "./types.js";

export interface DetectorContext {
  project: string;
  tenantId?: string | null;
  repository: Repository;
}

export interface ConsolidationDetector {
  readonly kind: ConsolidationCandidateKind;
  readonly label: string;
  detect(context: DetectorContext): ConsolidationCandidate[];
}
