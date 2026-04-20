export {
  DEFAULT_SUNSET_REGISTRY_PATH,
  inspectSunsetRegistry,
  loadSunsetRegistry,
  SunsetCandidateSchema
} from "./registry.js";
export type {
  SunsetCandidate,
  SunsetRegistryDegraded,
  SunsetRegistryLoadResult
} from "./registry.js";
export { evaluateSunsetCandidates } from "./evaluator.js";
export type { SunsetEvaluationResult, SunsetStatus } from "./evaluator.js";
export {
  DEFAULT_SUNSET_CHANGELOG_PATH,
  createChangelogNotifier
} from "./notifier.js";
export type { SunsetNotifier, SunsetReadyEvent } from "./notifier.js";
export {
  DEFAULT_SUNSET_CHECK_INTERVAL_MS,
  resolveSunsetCheckIntervalMs,
  SunsetScheduler
} from "./scheduler.js";
