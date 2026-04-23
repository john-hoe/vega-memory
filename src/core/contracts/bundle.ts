import { z } from "zod";

import { SOURCE_KINDS } from "./enums.js";

export const BUNDLE_RECORD_PROVENANCE_SCHEMA = z.object({
  origin: z.string(),
  retrieved_at: z.string().datetime()
});

export const BUNDLE_RECORD_SCHEMA = z.object({
  id: z.string(),
  record_id: z.string().optional(),
  source_kind: z.enum(SOURCE_KINDS),
  content: z.string(),
  provenance: BUNDLE_RECORD_PROVENANCE_SCHEMA,
  score: z.number().optional()
});

export const BUNDLE_SECTION_SCHEMA = z.object({
  kind: z.string().default("unknown"),
  title: z.string().default("unknown"),
  source_kind: z.enum(SOURCE_KINDS).optional(),
  records: z.array(BUNDLE_RECORD_SCHEMA)
});

export const BUNDLE_SCHEMA = z.object({
  schema_version: z.literal("1.0"),
  checkpoint_id: z.string().default(""),
  bundle_digest: z.string(),
  sections: z.array(BUNDLE_SECTION_SCHEMA),
  used_sources: z.array(z.enum(SOURCE_KINDS)).default([]),
  fallback_used: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0),
  warnings: z.array(z.string()).default([]),
  next_retrieval_hint: z.string().default("none")
});

export type BundleRecordProvenance = z.infer<typeof BUNDLE_RECORD_PROVENANCE_SCHEMA>;
export type BundleRecord = z.infer<typeof BUNDLE_RECORD_SCHEMA>;
export type BundleSection = z.infer<typeof BUNDLE_SECTION_SCHEMA>;
export type Bundle = z.infer<typeof BUNDLE_SCHEMA>;
export type BundleInput = z.input<typeof BUNDLE_SCHEMA>;
