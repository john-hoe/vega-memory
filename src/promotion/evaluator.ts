import type { CandidateMemoryRecord } from "../db/candidate-repository.js";
import { recordKey } from "../core/contracts/checkpoint-record.js";
import type { AckRecord, AckStore } from "../usage/ack-store.js";
import type {
  PromotionCurrentState,
  PromotionDecision,
  PromotionPolicy,
  PromotionTrigger
} from "./policy.js";

export interface PromotionEvaluatorOptions {
  policy: PromotionPolicy;
  ackStore?: AckStore;
  now?: () => number;
}

export interface PromotionEvaluator {
  evaluate(
    candidate: CandidateMemoryRecord,
    trigger: PromotionTrigger,
    actor?: string,
    current_state?: PromotionCurrentState
  ): PromotionDecision;
}

interface AckHistoryReadable {
  listRecentForRecord(record_id: string, filter: {
    since: number;
    sufficiency?: AckRecord["sufficiency"];
  }): ReadonlyArray<AckRecord>;
}

interface LegacyAckHistoryReadable {
  listRecent(filter: {
    since: number;
    sufficiency?: AckRecord["sufficiency"];
  }): ReadonlyArray<AckRecord>;
}

function hasAckHistoryReader(value: AckStore | undefined): value is AckStore & AckHistoryReadable {
  return (
    typeof value === "object" &&
    value !== null &&
    "listRecentForRecord" in value &&
    typeof (value as { listRecentForRecord?: unknown }).listRecentForRecord === "function"
  );
}

function hasLegacyAckHistoryReader(
  value: AckStore | undefined
): value is AckStore & LegacyAckHistoryReadable {
  return (
    typeof value === "object" &&
    value !== null &&
    "listRecent" in value &&
    typeof (value as { listRecent?: unknown }).listRecent === "function"
  );
}

function listLineageAckHistory(
  ackStore: AckStore & AckHistoryReadable,
  candidate: CandidateMemoryRecord
): ReadonlyArray<AckRecord> {
  const lineageRecordIds = [
    recordKey("candidate", candidate.id),
    recordKey("vega_memory", candidate.id)
  ];
  const seenCheckpointIds = new Set<string>();
  const ackHistory: AckRecord[] = [];

  for (const record_id of lineageRecordIds) {
    for (const ack of ackStore.listRecentForRecord(record_id, {
      since: candidate.created_at,
      sufficiency: "sufficient"
    })) {
      if (seenCheckpointIds.has(ack.checkpoint_id)) {
        continue;
      }

      seenCheckpointIds.add(ack.checkpoint_id);
      ackHistory.push(ack);
    }
  }

  return ackHistory.sort((left, right) => right.acked_at - left.acked_at);
}

export function createPromotionEvaluator(
  options: PromotionEvaluatorOptions
): PromotionEvaluator {
  const now = options.now ?? (() => Date.now());

  return {
    evaluate(candidate, trigger, _actor, current_state = "candidate"): PromotionDecision {
      const currentTime = now();
      const ack_history = hasAckHistoryReader(options.ackStore)
        ? listLineageAckHistory(options.ackStore, candidate)
        : hasLegacyAckHistoryReader(options.ackStore)
          ? options.ackStore.listRecent({
              since: candidate.created_at,
              sufficiency: "sufficient"
            })
        : undefined;

      return options.policy.decide({
        candidate,
        current_state,
        trigger,
        now: currentTime,
        ack_history
      });
    }
  };
}
