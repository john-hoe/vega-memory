import { z } from "zod";

import { BUNDLE_SECTION_SCHEMA } from "./bundle.js";
import { HOST_TIERS, SUFFICIENCY } from "./enums.js";

export const USAGE_ACK_SCHEMA = z.object({
  checkpoint_id: z.string().min(1),
  bundle_digest: z.string().min(1),
  sufficiency: z.enum(SUFFICIENCY),
  host_tier: z.enum(HOST_TIERS),
  evidence: z.string().optional(),
  turn_elapsed_ms: z.number().int().nonnegative().optional(),
  bundle_sections: z.array(BUNDLE_SECTION_SCHEMA).optional()
});

export type UsageAck = z.infer<typeof USAGE_ACK_SCHEMA>;
