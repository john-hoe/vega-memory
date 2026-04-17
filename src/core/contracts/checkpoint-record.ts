import { z } from "zod";

import { INTENTS, MODES, SURFACES } from "./enums.js";

export const CHECKPOINT_RECORD_SCHEMA = z.object({
  checkpoint_id: z.string(),
  bundle_digest: z.string(),
  intent: z.enum(INTENTS),
  surface: z.enum(SURFACES),
  session_id: z.string(),
  project: z.string().nullable(),
  cwd: z.string().nullable(),
  query_hash: z.string(),
  mode: z.enum(MODES),
  profile_used: z.string(),
  ranker_version: z.string(),
  record_ids: z.array(z.string()),
  created_at: z.number().int(),
  ttl_expires_at: z.number().int()
});

export type CheckpointRecord = z.infer<typeof CHECKPOINT_RECORD_SCHEMA>;

export function recordKey(source_kind: string, id: string): string {
  return `${source_kind}:${id}`;
}
