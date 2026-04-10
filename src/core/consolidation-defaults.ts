import { ConflictAggregationDetector } from "./detectors/conflict-aggregation-detector.js";
import { DuplicateDetector } from "./detectors/duplicate-detector.js";
import { ExpiredFactDetector } from "./detectors/expired-fact-detector.js";
import { GlobalPromotionDetector } from "./detectors/global-promotion-detector.js";
import { WikiSynthesisDetector } from "./detectors/wiki-synthesis-detector.js";
import type { ConsolidationDetector } from "./consolidation-detector.js";
import type { ConsolidationReportEngine } from "./consolidation-report-engine.js";
import type { ConsolidationCandidateKind } from "./types.js";

export const createDefaultConsolidationDetectors = (): ConsolidationDetector[] => [
  new DuplicateDetector(),
  new ExpiredFactDetector(),
  new GlobalPromotionDetector(),
  new WikiSynthesisDetector(),
  new ConflictAggregationDetector()
];

export const registerDefaultConsolidationDetectors = (
  engine: ConsolidationReportEngine,
  enabledKinds?: ConsolidationCandidateKind[]
): void => {
  const enabled = enabledKinds ? new Set(enabledKinds) : null;

  for (const detector of createDefaultConsolidationDetectors()) {
    if (enabled !== null && !enabled.has(detector.kind)) {
      continue;
    }

    engine.registerDetector(detector);
  }
};
