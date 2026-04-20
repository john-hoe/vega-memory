import { appendFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { createLogger } from "../core/logging/index.js";

import type { SunsetEvaluationResult } from "./evaluator.js";
import type { SunsetCandidate } from "./registry.js";

const logger = createLogger({ name: "sunset-notifier" });

export const DEFAULT_SUNSET_CHANGELOG_PATH = resolve(process.cwd(), "CHANGELOG.md");

export interface SunsetReadyEvent {
  candidate: SunsetCandidate;
  evaluation: SunsetEvaluationResult;
}

export type SunsetNotifier = (event: SunsetReadyEvent) => Promise<void>;

const appendChangelogEntry = (path: string, event: SunsetReadyEvent): void => {
  const prefix = existsSync(path) && statSync(path).size > 0 ? "\n" : "";
  const entry = [
    `${prefix}## Sunset candidate ready: ${event.candidate.id}`,
    `- Target: ${event.candidate.target}`,
    `- Deprecated since: ${event.candidate.deprecated_since}`,
    `- Criteria met: ${event.evaluation.reasons.join("; ")}`,
    `- Detected at: ${event.evaluation.evaluated_at}`,
    ""
  ].join("\n");

  appendFileSync(path, entry, "utf8");
};

const safeLog = (event: SunsetReadyEvent): void => {
  try {
    logger[event.candidate.notification.log_level]("Sunset candidate ready.", {
      candidate_id: event.candidate.id,
      target: event.candidate.target,
      deprecated_since: event.candidate.deprecated_since,
      reasons: event.evaluation.reasons,
      evaluated_at: event.evaluation.evaluated_at
    });
  } catch (error) {
    console.warn("Sunset notifier logger failed", error);
  }
};

export function createChangelogNotifier(changelogPath = DEFAULT_SUNSET_CHANGELOG_PATH): SunsetNotifier {
  const resolvedPath = resolve(changelogPath);

  return async (event: SunsetReadyEvent): Promise<void> => {
    try {
      if (event.candidate.notification.changelog) {
        appendChangelogEntry(resolvedPath, event);
      }
    } catch (error) {
      logger.error("Failed to append sunset changelog entry.", {
        path: resolvedPath,
        candidate_id: event.candidate.id,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      safeLog(event);
    }
  };
}
