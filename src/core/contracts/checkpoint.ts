import { z } from "zod";

import { HOST_TIERS, SUFFICIENCY } from "./enums.js";

export const CHECKPOINT_SCHEMA = z.object({
  checkpoint_id: z.string(),
  bundle_digest: z.string(),
  sufficiency: z.enum(SUFFICIENCY),
  host_tier: z.enum(HOST_TIERS),
  evidence: z.string().optional(),
  turn_elapsed_ms: z.number().optional()
});

export type Checkpoint = z.infer<typeof CHECKPOINT_SCHEMA>;
