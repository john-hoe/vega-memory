import type { SourceKind } from "../../core/contracts/enums.js";
import type { IntentRequest } from "../../core/contracts/intent.js";

export type SourceSearchDepth = "minimal" | "standard" | "extended" | "evidence";

export interface SourceRecord {
  id: string;
  source_kind: SourceKind;
  content: string;
  created_at?: string | number | Date;
  provenance: {
    origin: string;
    retrieved_at: string;
  };
  raw_score?: number;
  metadata?: Record<string, unknown>;
}

export interface SourceSearchInput {
  request: IntentRequest;
  top_k: number;
  depth: SourceSearchDepth;
}

export interface SourceAdapter {
  kind: SourceKind;
  name: string;
  enabled: boolean;
  search(input: SourceSearchInput): SourceRecord[];
}
