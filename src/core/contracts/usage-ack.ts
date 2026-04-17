import { z } from "zod";

import { HOST_TIERS, SUFFICIENCY } from "./enums.js";

export const USAGE_ACK_SCHEMA = z.object({
  checkpoint_id: z.string().min(1),
  bundle_digest: z.string().min(1),
  sufficiency: z.enum(SUFFICIENCY),
  host_tier: z.enum(HOST_TIERS),
  evidence: z.string().optional(),
  turn_elapsed_ms: z.number().int().nonnegative().optional()
});

export type UsageAck = z.infer<typeof USAGE_ACK_SCHEMA>;
