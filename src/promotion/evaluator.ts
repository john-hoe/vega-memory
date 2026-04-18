import type { CandidateMemoryRecord } from "../db/candidate-repository.js";
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
  listRecent(filter: {
    since: number;
    sufficiency?: AckRecord["sufficiency"];
  }): ReadonlyArray<AckRecord>;
}

function hasAckHistoryReader(value: AckStore | undefined): value is AckStore & AckHistoryReadable {
  return (
    typeof value === "object" &&
    value !== null &&
    "listRecent" in value &&
    typeof (value as { listRecent?: unknown }).listRecent === "function"
  );
}

export function createPromotionEvaluator(
  options: PromotionEvaluatorOptions
): PromotionEvaluator {
  const now = options.now ?? (() => Date.now());

  return {
    evaluate(candidate, trigger, _actor, current_state = "candidate"): PromotionDecision {
      const currentTime = now();
      const ack_history = hasAckHistoryReader(options.ackStore)
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
