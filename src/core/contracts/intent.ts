import { z } from "zod";

import { INTENTS, MODES, SURFACES } from "./enums.js";

export const INTENT_BUDGET_OVERRIDE_SCHEMA = z.object({
  tokens: z.number().optional(),
  depth: z.number().optional()
});

export const INTENT_REQUEST_SCHEMA = z.object({
  intent: z.enum(INTENTS),
  mode: z.enum(MODES).default("L1"),
  query: z.string().optional(),
  surface: z.enum(SURFACES),
  session_id: z.string(),
  project: z.string().nullable(),
  cwd: z.string().nullable(),
  budget_override: INTENT_BUDGET_OVERRIDE_SCHEMA.optional(),
  prev_checkpoint_id: z.string().optional()
});

export type IntentBudgetOverride = z.infer<typeof INTENT_BUDGET_OVERRIDE_SCHEMA>;
export type IntentRequest = z.infer<typeof INTENT_REQUEST_SCHEMA>;
