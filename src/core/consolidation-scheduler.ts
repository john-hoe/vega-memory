import { randomUUID } from "node:crypto";

import {
  isConsolidationAutoExecuteEnabled,
  isConsolidationReportEnabled,
  type VegaConfig
} from "../config.js";
import type { Repository } from "../db/repository.js";
import { ConsolidationApprovalService } from "./consolidation-approval.js";
import { ConsolidationAuditService } from "./consolidation-audit.js";
import { registerDefaultConsolidationDetectors } from "./consolidation-defaults.js";
import { ConsolidationExecutor, isAutoExecutableConsolidationAction } from "./consolidation-executor.js";
import { CompactService } from "./compact.js";
import { MemoryService } from "./memory.js";
import { ConsolidationReportEngine } from "./consolidation-report-engine.js";
import type {
  ConsolidationPolicy,
  ConsolidationRunRecord
} from "./types.js";
import {
  CONSOLIDATION_CANDIDATE_KINDS,
  LOW_RISK_CONSOLIDATION_AUTO_ACTIONS
} from "./types.js";

const DEFAULT_MIN_WRITES_THRESHOLD = 25;

export class ConsolidationScheduler {
  constructor(
    private readonly repository: Repository,
    private readonly config: VegaConfig
  ) {}

  getDefaultPolicy(): ConsolidationPolicy {
    return {
      trigger: "manual",
      mode: "dry_run",
      min_writes_threshold: DEFAULT_MIN_WRITES_THRESHOLD,
      enabled_detectors: [...CONSOLIDATION_CANDIDATE_KINDS],
      auto_actions: []
    };
  }

  run(
    project: string,
    tenantId?: string | null,
    policy?: Partial<ConsolidationPolicy>
  ): ConsolidationRunRecord {
    if (!isConsolidationReportEnabled(this.config)) {
      throw new Error("consolidation_report feature is disabled");
    }

    const auditService = new ConsolidationAuditService(this.repository);
    const resolvedPolicy = this.resolvePolicy(policy);
    const runId = this.createUniqueRunId(auditService);
    const engine = new ConsolidationReportEngine(this.repository, this.config);

    registerDefaultConsolidationDetectors(engine, resolvedPolicy.enabled_detectors);

    const report = engine.generateReport(project, tenantId, {
      runId,
      mode: resolvedPolicy.mode
    });
    const candidates = report.sections.flatMap((section) => section.candidates);
    const errors = [...report.execution.errors];
    let actionsExecuted = 0;
    const approvalService = new ConsolidationApprovalService(this.repository);

    if (resolvedPolicy.mode === "auto_low_risk") {
      if (isConsolidationAutoExecuteEnabled(this.config)) {
        const executor = new ConsolidationExecutor(
          this.repository,
          new MemoryService(this.repository, this.config),
          new CompactService(this.repository, this.config),
          this.config
        );
        const executionResult = executor.execute(candidates, resolvedPolicy);

        actionsExecuted = executionResult.executed.filter(
          (entry) => entry.success && isAutoExecutableConsolidationAction(entry.action)
        ).length;

        for (const entry of executionResult.executed) {
          if (!entry.success && entry.error) {
            errors.push(`candidate ${entry.candidate_index}: ${entry.error}`);
          }
        }
      } else {
        errors.push(
          "Auto execution requested but features.consolidationAutoExecute is disabled"
        );
      }
    }

    try {
      approvalService.submitCandidates(runId, candidates, project, tenantId);
    } catch (error) {
      errors.push(
        `approval queue: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    report.execution.errors = errors;

    const record: ConsolidationRunRecord = {
      run_id: runId,
      project,
      tenant_id: tenantId ?? null,
      trigger: resolvedPolicy.trigger,
      mode: resolvedPolicy.mode,
      started_at: report.execution.started_at,
      completed_at: report.execution.completed_at,
      duration_ms: report.execution.duration_ms,
      total_candidates: report.execution.total_candidates,
      actions_executed: actionsExecuted,
      actions_skipped: Math.max(0, report.summary.total_candidates - actionsExecuted),
      errors
    };

    auditService.recordRun(record, JSON.stringify(report));

    return record;
  }

  shouldTrigger(trigger: ConsolidationPolicy["trigger"], project: string): boolean {
    if (!isConsolidationReportEnabled(this.config)) {
      return false;
    }

    if (trigger !== "after_writes") {
      return true;
    }

    const lastRun = new ConsolidationAuditService(this.repository).getLastRun(project);
    const since = lastRun?.completed_at ?? "1970-01-01T00:00:00.000Z";
    const writes = this.repository.countProjectMemoryWritesSince(project, since);

    return writes >= this.getDefaultPolicy().min_writes_threshold;
  }

  private resolvePolicy(policy?: Partial<ConsolidationPolicy>): ConsolidationPolicy {
    const defaults = this.getDefaultPolicy();
    const mode = policy?.mode ?? defaults.mode;

    return {
      ...defaults,
      ...policy,
      mode,
      enabled_detectors: policy?.enabled_detectors
        ? [...policy.enabled_detectors]
        : [...defaults.enabled_detectors],
      auto_actions:
        policy?.auto_actions !== undefined
          ? [...policy.auto_actions]
          : mode === "auto_low_risk"
            ? [...LOW_RISK_CONSOLIDATION_AUTO_ACTIONS]
            : []
    };
  }

  private createUniqueRunId(auditService: ConsolidationAuditService): string {
    let runId = randomUUID();

    while (auditService.isIdempotent(runId)) {
      runId = randomUUID();
    }

    return runId;
  }
}
