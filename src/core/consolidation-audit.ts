import type { Repository } from "../db/repository.js";
import type { ConsolidationRunRecord } from "./types.js";

export class ConsolidationAuditService {
  constructor(private readonly repository: Repository) {}

  recordRun(record: ConsolidationRunRecord, reportJson?: string): void {
    this.repository.insertConsolidationRun({
      ...record,
      report_json: reportJson ?? null
    });
  }

  getLastRun(project: string, tenantId?: string | null): ConsolidationRunRecord | null {
    return this.repository.getLastConsolidationRun(project, tenantId);
  }

  listRuns(
    project: string,
    limit = 20,
    tenantId?: string | null
  ): ConsolidationRunRecord[] {
    return this.repository.listConsolidationRuns(project, limit, tenantId);
  }

  isIdempotent(runId: string): boolean {
    return this.repository.consolidationRunExists(runId);
  }
}
