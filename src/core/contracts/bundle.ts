import { z } from "zod";

import { SOURCE_KINDS } from "./enums.js";

export const BUNDLE_RECORD_PROVENANCE_SCHEMA = z.object({
  origin: z.string(),
  retrieved_at: z.string().datetime()
});

export const BUNDLE_RECORD_SCHEMA = z.object({
  id: z.string(),
  source_kind: z.enum(SOURCE_KINDS),
  content: z.string(),
  provenance: BUNDLE_RECORD_PROVENANCE_SCHEMA,
  score: z.number().optional()
});

export const BUNDLE_SECTION_SCHEMA = z.object({
  source_kind: z.enum(SOURCE_KINDS),
  records: z.array(BUNDLE_RECORD_SCHEMA)
});

export const BUNDLE_SCHEMA = z.object({
  bundle_digest: z.string(),
  sections: z.array(BUNDLE_SECTION_SCHEMA)
});

export type BundleRecordProvenance = z.infer<typeof BUNDLE_RECORD_PROVENANCE_SCHEMA>;
export type BundleRecord = z.infer<typeof BUNDLE_RECORD_SCHEMA>;
export type BundleSection = z.infer<typeof BUNDLE_SECTION_SCHEMA>;
export type Bundle = z.infer<typeof BUNDLE_SCHEMA>;
