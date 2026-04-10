import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { VegaConfig } from "../config.js";
import type { Repository } from "../db/repository.js";
import type { ConsolidationDetector } from "./consolidation-detector.js";
import type {
  ConsolidationCandidate,
  ConsolidationCandidateKind,
  ConsolidationReport,
  ConsolidationReportSection
} from "./types.js";

export class ConsolidationReportEngine {
  private readonly detectors: ConsolidationDetector[] = [];

  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {
    void this.config;
  }

  registerDetector(detector: ConsolidationDetector): void {
    this.detectors.push(detector);
  }

  generateReport(project: string, tenantId?: string | null): ConsolidationReport {
    const runId = randomUUID();
    const startedAtDate = new Date();
    const startedAt = startedAtDate.toISOString();
    const startedAtPerf = performance.now();
    const errors: string[] = [];
    const sections: ConsolidationReportSection[] = [];

    for (const detector of this.detectors) {
      try {
        sections.push({
          kind: detector.kind,
          label: detector.label,
          candidates: detector.detect({
            project,
            tenantId,
            repository: this.repository
          })
        });
      } catch (error) {
        errors.push(
          `${detector.kind}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const durationMs = Number((performance.now() - startedAtPerf).toFixed(3));
    const completedAtDate = new Date();
    const normalizedCompletedAtDate =
      completedAtDate.getTime() <= startedAtDate.getTime()
        ? new Date(startedAtDate.getTime() + 1)
        : completedAtDate;
    const completedAt = normalizedCompletedAtDate.toISOString();

    const allCandidates = sections.flatMap((section) => section.candidates);
    const candidatesByKind = sections.reduce<
      Partial<Record<ConsolidationCandidateKind, number>>
    >((counts, section) => {
      counts[section.kind] = section.candidates.length;
      return counts;
    }, {});

    return {
      version: 1,
      execution: {
        run_id: runId,
        project,
        tenant_id: tenantId ?? null,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: durationMs,
        total_candidates: allCandidates.length,
        candidates_by_kind: candidatesByKind,
        errors,
        mode: "dry_run"
      },
      sections,
      summary: {
        total_candidates: allCandidates.length,
        low_risk: countCandidatesByRisk(allCandidates, "low"),
        medium_risk: countCandidatesByRisk(allCandidates, "medium"),
        high_risk: countCandidatesByRisk(allCandidates, "high")
      }
    };
  }
}

const countCandidatesByRisk = (
  candidates: ConsolidationCandidate[],
  risk: ConsolidationCandidate["risk"]
): number => candidates.filter((candidate) => candidate.risk === risk).length;
