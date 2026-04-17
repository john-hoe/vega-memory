import type { HostEventEnvelopeV1 } from "../core/contracts/envelope.js";
import type { DatabaseAdapter } from "../db/adapter.js";
import { insertRawEvent } from "./raw-inbox.js";
import { readFeatureFlag } from "./feature-flags.js";

export interface ShadowWriterConfig {
  flagName?: string;
  db: DatabaseAdapter;
}

export interface ShadowWriteOutcome {
  executed: boolean;
  accepted?: boolean;
  event_id?: string;
  reason?: "deduped" | "disabled" | "error";
  error?: string;
}

const DEFAULT_FLAG_NAME = "VEGA_SHADOW_DUAL_WRITE";

export function createShadowWriter(
  config: ShadowWriterConfig
): (envelope: HostEventEnvelopeV1) => ShadowWriteOutcome {
  const flagName = config.flagName ?? DEFAULT_FLAG_NAME;

  return (envelope: HostEventEnvelopeV1): ShadowWriteOutcome => {
    if (!readFeatureFlag(flagName)) {
      return {
        executed: false,
        reason: "disabled"
      };
    }

    try {
      const result = insertRawEvent(config.db, envelope);

      return {
        executed: true,
        accepted: result.accepted,
        event_id: result.event_id,
        ...(result.reason === undefined ? {} : { reason: result.reason })
      };
    } catch (error) {
      return {
        executed: true,
        accepted: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  };
}
