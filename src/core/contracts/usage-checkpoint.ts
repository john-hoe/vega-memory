import { z } from "zod";

import { SUFFICIENCY } from "./enums.js";

export const USAGE_CHECKPOINT_SCHEMA = z.object({
  bundle_id: z.string().min(1),
  checkpoint_id: z.string().min(1),
  decision_state: z.enum(SUFFICIENCY),
  used_items: z.array(z.string().min(1)),
  working_summary: z.string(),
  bundle_digest: z.string().min(1).optional(),
  bundle_summary: z.string().optional()
});

export type UsageCheckpoint = z.infer<typeof USAGE_CHECKPOINT_SCHEMA>;
export type UsageCheckpointInput = z.input<typeof USAGE_CHECKPOINT_SCHEMA>;
