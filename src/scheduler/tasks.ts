import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { LifecycleManager } from "../core/lifecycle.js";
import { MemoryService } from "../core/memory.js";
import { exportSnapshot } from "../core/snapshot.js";
import { generateSummary } from "../core/summarize.js";
import type { MemoryStatus, MemoryType } from "../core/types.js";
import { cleanOldBackups, createBackup, shouldBackup } from "../db/backup.js";
import { Repository } from "../db/repository.js";
import { generateEmbedding, isOllamaAvailable } from "../embedding/ollama.js";
import { ContentDistiller } from "../ingestion/distiller.js";
import { ContentFetcher } from "../ingestion/fetcher.js";
import { RSSService } from "../ingestion/rss.js";
import { InsightGenerator } from "../insights/generator.js";
import type { NotificationManager } from "../notify/manager.js";
import {
  createReconciliationAlertCooldown,
  evaluateReconciliationAlerts,
  type ReconciliationAlert,
  type ReconciliationAlertConfig,
  type ReconciliationAlertInput,
  type ReconciliationAlertCooldown
} from "../reconciliation/alert.js";
import {
  createPerDimensionAlertDispatcher,
  type AlertDispatcher
} from "../reconciliation/alert-dispatcher.js";
import { ReconciliationOrchestrator } from "../reconciliation/orchestrator.js";
import type { ReconciliationDimension, ReconciliationReport } from "../reconciliation/report.js";
import { resolveConfiguredEncryptionKey } from "../security/keychain.js";
import { CrossReferenceService } from "../wiki/cross-reference.js";
import { PageManager } from "../wiki/page-manager.js";
import { SynthesisEngine } from "../wiki/synthesis.js";
import { StalenessService } from "../wiki/staleness.js";

interface CountRow<TName extends string> {
  name: TName;
  count: number;
}

interface IntegrityCheckRow {
  integrity_check: string;
}

interface AverageLatencyRow {
  average_latency: number | null;
  entry_count: number;
}

interface TopAccessedMemoryRow {
  id: string;
  title: string;
  access_count: number;
  accessed_at: string;
}

export interface DailyMaintenanceOptions {
  notificationManager?: NotificationManager;
  alertDispatcher?: AlertDispatcher;
  rssService?: RSSService;
  contentFetcher?: ContentFetcher;
  contentDistiller?: ContentDistiller;
  pageManager?: PageManager;
  synthesisEngine?: SynthesisEngine;
  crossReferenceService?: CrossReferenceService;
  stalenessService?: StalenessService;
  resolveEncryptionKey?: (config: VegaConfig) => Promise<string | undefined>;
  now?: () => number;
  runReconciliation?: (args: {
    repository: Repository;
    window_start: number;
    window_end: number;
    dimensions: ReconciliationDimension[];
  }) => Promise<ReconciliationReport>;
  reconciliationAlertConfig?: ReconciliationAlertConfig;
  reconciliationAlertCooldown?: ReconciliationAlertCooldown;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RECONCILIATION_WINDOW_HOURS = 24;
const DEFAULT_RECONCILIATION_FLAP_COOLDOWN_MS = HOUR_MS;
const DEFAULT_RECONCILIATION_DIMENSIONS: ReconciliationDimension[] = [
  "count",
  "shape",
  "semantic",
  "ordering"
];
const RECONCILIATION_AUTO_ENABLED_ENV = "VEGA_RECONCILIATION_AUTO_ENABLED";
const RECONCILIATION_WINDOW_HOURS_ENV = "VEGA_RECONCILIATION_WINDOW_HOURS";
const RECONCILIATION_SCHEDULE_CRON_ENV = "VEGA_RECONCILIATION_SCHEDULE_CRON";
const RECONCILIATION_FLAP_COOLDOWN_ENV = "VEGA_RECONCILIATION_FLAP_COOLDOWN_MS";
const RECONCILIATION_SEMANTIC_SAMPLE_SIZE_ENV = "VEGA_RECONCILIATION_SEMANTIC_SAMPLE_SIZE";
const RECONCILIATION_SHAPE_FIELD_COUNT = 5;

let ollamaDownSince: number | null = null;
let ollamaWarningSent = false;
const defaultReconciliationAlertCooldown = createReconciliationAlertCooldown();

const timestamp = (): string => new Date().toISOString();

const log = (message: string): void => {
  console.log(`[${timestamp()}] ${message}`);
};

const logError = (message: string): void => {
  console.error(`[${timestamp()}] ${message}`);
};

const formatDate = (value: Date): string => value.toISOString().slice(0, 10);

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.stack ?? error.message : String(error);

const formatPercent = (count: number, total: number): string =>
  total === 0 ? "0.0" : ((count / total) * 100).toFixed(1);

const resolvePositiveInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const isReconciliationAutoEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[RECONCILIATION_AUTO_ENABLED_ENV] === "true";

const resolveReconciliationWindowHours = (env: NodeJS.ProcessEnv = process.env): number =>
  resolvePositiveInteger(env[RECONCILIATION_WINDOW_HOURS_ENV], DEFAULT_RECONCILIATION_WINDOW_HOURS);

const resolveReconciliationFlapCooldownMs = (env: NodeJS.ProcessEnv = process.env): number =>
  resolvePositiveInteger(env[RECONCILIATION_FLAP_COOLDOWN_ENV], DEFAULT_RECONCILIATION_FLAP_COOLDOWN_MS);

const resolveReconciliationSemanticSampleSize = (env: NodeJS.ProcessEnv = process.env): number =>
  resolvePositiveInteger(env[RECONCILIATION_SEMANTIC_SAMPLE_SIZE_ENV], 50);

const parseCronLiteral = (
  value: string,
  minimum: number,
  maximum: number
): number | null => {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (parsed < minimum || parsed > maximum) {
    return null;
  }

  return parsed;
};

const matchesCronField = (fieldSpec: string, currentValue: number, minimum: number, maximum: number): boolean => {
  if (fieldSpec === "*") {
    return true;
  }

  for (const rawPart of fieldSpec.split(",")) {
    const part = rawPart.trim();

    if (part === "*") {
      return true;
    }

    // Support */N step syntax in addition to literals, ranges, and comma lists.
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = parseCronLiteral(stepMatch[1]!, 1, maximum);

      if (step !== null && currentValue % step === 0) {
        return true;
      }

      continue;
    }

    const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
    if (rangeMatch) {
      const lower = parseCronLiteral(rangeMatch[1]!, minimum, maximum);
      const upper = parseCronLiteral(rangeMatch[2]!, minimum, maximum);

      if (lower !== null && upper !== null && lower <= upper) {
        if (currentValue >= lower && currentValue <= upper) {
          return true;
        }
      }

      continue;
    }

    const literal = parseCronLiteral(part, minimum, maximum);
    if (literal !== null && literal === currentValue) {
      return true;
    }
  }

  return false;
};

const matchesCronSchedule = (expression: string, value: Date): boolean => {
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(`Expected 5 cron fields, received ${tokens.length}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = tokens;
  return (
    matchesCronField(minute!, value.getMinutes(), 0, 59) &&
    matchesCronField(hour!, value.getHours(), 0, 23) &&
    matchesCronField(dayOfMonth!, value.getDate(), 1, 31) &&
    matchesCronField(month!, value.getMonth() + 1, 1, 12) &&
    matchesCronField(dayOfWeek!, value.getDay(), 0, 6)
  );
};

const shouldRunReconciliationForCurrentSchedule = (
  value: Date,
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  const cron = env[RECONCILIATION_SCHEDULE_CRON_ENV]?.trim();
  if (cron === undefined || cron.length === 0) {
    return true;
  }

  try {
    return matchesCronSchedule(cron, value);
  } catch (error) {
    logError(`Invalid ${RECONCILIATION_SCHEDULE_CRON_ENV}: ${getErrorMessage(error)}`);
    return false;
  }
};

const getDataDir = (config: VegaConfig): string =>
  config.dbPath === ":memory:" ? resolve(process.cwd(), "data") : dirname(resolve(config.dbPath));

const getBackupDir = (config: VegaConfig): string => join(getDataDir(config), "backups");

const getSnapshotPath = (config: VegaConfig): string =>
  join(getDataDir(config), "snapshots", `snapshot-${formatDate(new Date())}.md`);

const getWeeklyReportPath = (config: VegaConfig): string =>
  join(getDataDir(config), "reports", `weekly-${formatDate(new Date())}.md`);

const formatDailyErrorDetail = (errors: string[]): string =>
  errors.map((error, index) => `${index + 1}. ${error}`).join("\n");

const formatWeeklySummary = (
  generatedAt: string,
  integrityResult: string,
  totalCount: number,
  staleCount: number
): string =>
  [
    `Generated: ${generatedAt}`,
    `Integrity: ${integrityResult}`,
    `Total memories: ${totalCount}`,
    `Not accessed in 30+ days: ${staleCount}`
  ].join("\n");

const notifySafely = async (
  label: string,
  notification: (() => Promise<void>) | undefined
): Promise<void> => {
  if (notification === undefined) {
    return;
  }

  try {
    await notification();
  } catch (error) {
    logError(`${label} failed: ${getErrorMessage(error)}`);
  }
};

const flushDailyDigestSafely = async (
  notificationManager: NotificationManager | undefined
): Promise<boolean> => {
  if (notificationManager === undefined) {
    return false;
  }

  try {
    return await notificationManager.flushDailyDigest();
  } catch (error) {
    logError(`Daily warning digest failed: ${getErrorMessage(error)}`);
    return false;
  }
};

const countJoinedReconciliationRows = (
  repository: Repository,
  windowStart: number,
  windowEnd: number
): number =>
  repository.db
    .prepare<[string, string], { count: number }>(
      `SELECT COUNT(*) AS count
       FROM memories AS memory
       INNER JOIN raw_inbox AS raw
         ON raw.event_id = memory.id
       WHERE memory.created_at >= ? AND memory.created_at < ?`
    )
    .get(new Date(windowStart).toISOString(), new Date(windowEnd).toISOString())?.count ?? 0;

const toReconciliationAlertInputs = (
  report: ReconciliationReport,
  repository: Repository,
  windowStart: number,
  windowEnd: number,
  env: NodeJS.ProcessEnv = process.env
): ReconciliationAlertInput[] => {
  const joinedRows = countJoinedReconciliationRows(repository, windowStart, windowEnd);
  const semanticSampleSize = Math.min(joinedRows, resolveReconciliationSemanticSampleSize(env));

  return report.dimensions.map((dimension) => {
    const mismatchCount = dimension.findings.reduce(
      (total, finding) => total + finding.mismatch_count,
      0
    );

    if (dimension.dimension === "count") {
      const memoryChecked = dimension.findings
        .filter((finding) => finding.direction === "forward")
        .reduce((total, finding) => total + (finding.expected ?? 0), 0);
      const rawChecked = dimension.findings
        .filter((finding) => finding.direction === "reverse")
        .reduce((total, finding) => total + (finding.expected ?? 0), 0);

      return {
        dimension: dimension.dimension,
        status: dimension.status,
        mismatch_count: mismatchCount,
        compared_count: Math.max(memoryChecked, rawChecked, mismatchCount)
      };
    }

    if (dimension.dimension === "shape") {
      return {
        dimension: dimension.dimension,
        status: dimension.status,
        mismatch_count: mismatchCount,
        compared_count: Math.max(joinedRows * RECONCILIATION_SHAPE_FIELD_COUNT, mismatchCount)
      };
    }

    if (dimension.dimension === "semantic") {
      return {
        dimension: dimension.dimension,
        status: dimension.status,
        mismatch_count: mismatchCount,
        compared_count: Math.max(semanticSampleSize, mismatchCount)
      };
    }

    if (dimension.dimension === "ordering") {
      return {
        dimension: dimension.dimension,
        status: dimension.status,
        mismatch_count: mismatchCount,
        compared_count: Math.max(joinedRows, mismatchCount)
      };
    }

    return {
      dimension: dimension.dimension,
      status: dimension.status,
      mismatch_count: mismatchCount,
      compared_count: Math.max(mismatchCount, 0)
    };
  });
};

interface ReconciliationAlertSummaryNotifier {
  notifyWarning(title: string, detail: string): Promise<void>;
}

const formatReconciliationAlertSummary = (alerts: ReadonlyArray<ReconciliationAlert>): string =>
  `Reconciliation found ${alerts.length} alert(s) across dimensions: ${[
    ...new Set(alerts.map((alert) => alert.dimension))
  ].join(", ")}`;

export const dispatchReconciliationAlerts = async (args: {
  alerts: ReadonlyArray<ReconciliationAlert>;
  alertDispatcher: AlertDispatcher;
  notificationManager?: ReconciliationAlertSummaryNotifier;
  cooldown: ReconciliationAlertCooldown;
  cooldownMs: number;
  now: number;
}): Promise<number> => {
  const dispatchableAlerts = args.alerts.filter((alert) =>
    args.cooldown.shouldDispatch(alert, args.now, args.cooldownMs)
  );

  if (dispatchableAlerts.length === 0) {
    return 0;
  }

  try {
    await args.alertDispatcher.dispatch(dispatchableAlerts, new Date(args.now));
  } catch (error) {
    logError(`Reconciliation alert file dispatch failed: ${getErrorMessage(error)}`);
    return 0;
  }

  for (const alert of dispatchableAlerts) {
    args.cooldown.record(alert, args.now);
  }

  if (args.notificationManager !== undefined) {
    try {
      await args.notificationManager.notifyWarning(
        "Reconciliation Alerts",
        formatReconciliationAlertSummary(dispatchableAlerts)
      );
    } catch (error) {
      logError(`Reconciliation alert summary notification failed: ${getErrorMessage(error)}`);
    }
  }

  return dispatchableAlerts.length;
};

const runReconciliation = async (args: {
  repository: Repository;
  window_start: number;
  window_end: number;
  dimensions: ReconciliationDimension[];
}): Promise<ReconciliationReport> => {
  const reconciliationOrchestrator = new ReconciliationOrchestrator({
    db: args.repository.db
  });

  return reconciliationOrchestrator.run({
    window_start: args.window_start,
    window_end: args.window_end,
    dimensions: args.dimensions
  });
};

const toEmbeddingBuffer = (embedding: Float32Array): Buffer =>
  Buffer.from(
    embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength)
  );

const formatCountTable = <TName extends string>(title: string, rows: CountRow<TName>[]): string => {
  const lines = [
    `## ${title}`,
    "",
    "| Name | Count |",
    "| --- | ---: |"
  ];

  for (const row of rows) {
    lines.push(`| ${row.name} | ${row.count} |`);
  }

  if (rows.length === 0) {
    lines.push("| none | 0 |");
  }

  lines.push("");
  return lines.join("\n");
};

const formatTopAccessedTable = (rows: TopAccessedMemoryRow[]): string => {
  const lines = [
    "## Top 5 Most Accessed Memories",
    "",
    "| Rank | ID | Title | Access Count | Last Accessed |",
    "| ---: | --- | --- | ---: | --- |"
  ];

  if (rows.length === 0) {
    lines.push("| 1 | none | none | 0 | n/a |");
  }

  for (const [index, row] of rows.entries()) {
    lines.push(
      `| ${index + 1} | ${row.id} | ${row.title} | ${row.access_count} | ${row.accessed_at} |`
    );
  }

  lines.push("");
  return lines.join("\n");
};

const rebuildMissingEmbeddings = async (
  repository: Repository,
  config: VegaConfig
): Promise<{ rebuilt: number; failed: number }> => {
  const memories = repository
    .listMemories({
      limit: 1_000_000,
      sort: "updated_at DESC"
    })
    .filter((memory) => memory.embedding === null);
  let rebuilt = 0;
  let failed = 0;

  for (const memory of memories) {
    const embedding = await generateEmbedding(memory.content, config);

    if (embedding === null) {
      failed += 1;
      log(`Embedding regeneration failed for memory ${memory.id}`);
      continue;
    }

    repository.updateMemory(memory.id, {
      embedding: toEmbeddingBuffer(embedding),
      updated_at: timestamp()
    });
    rebuilt += 1;
  }

  return { rebuilt, failed };
};

export async function backfillSummaries(
  repository: Repository,
  _memoryService: MemoryService,
  config: VegaConfig
): Promise<{ updated: number; failed: number }> {
  const memories = repository.listMemoriesNeedingSummary();
  let updated = 0;
  let failed = 0;

  for (const memory of memories) {
    const summary = await generateSummary(memory.content, config);

    if (summary !== null) {
      repository.updateMemory(
        memory.id,
        {
          summary,
          updated_at: timestamp()
        },
        { skipVersion: true }
      );
      updated += 1;
    } else {
      failed += 1;
    }
  }

  return { updated, failed };
}

export async function dailyMaintenance(
  repository: Repository,
  compactService: CompactService,
  memoryService: MemoryService,
  config: VegaConfig,
  options: DailyMaintenanceOptions = {}
): Promise<void> {
  const backupDir = getBackupDir(config);
  const errors: string[] = [];
  let preserveAlert = false;
  const notificationManager = options.notificationManager;
  const resolveEncryptionKey =
    options.resolveEncryptionKey ??
    (async (config: VegaConfig) => resolveConfiguredEncryptionKey(config));
  const now = options.now ?? Date.now;
  const runReconciliationStep = options.runReconciliation ?? runReconciliation;
  const reconciliationAlertCooldown =
    options.reconciliationAlertCooldown ?? defaultReconciliationAlertCooldown;
  const recordError = (message: string): void => {
    errors.push(message);
    logError(message);
  };

  log("Daily maintenance started");

  log("Checking backup status");
  try {
    if (config.dbPath === ":memory:") {
      log("Backup skipped because the database is in-memory");
    } else if (shouldBackup(backupDir)) {
      await createBackup(
        config.dbPath,
        backupDir,
        undefined,
        await resolveEncryptionKey(config)
      );
      log(`Backup created in ${backupDir}`);
    } else {
      log("Backup skipped because a recent backup already exists");
    }
  } catch (error) {
    recordError(`Backup step failed: ${getErrorMessage(error)}`);
  }

  log("Running compaction");
  try {
    const compactResult = compactService.compact();
    log(
      `Compaction finished with ${compactResult.merged} merged and ${compactResult.archived} archived`
    );
  } catch (error) {
    recordError(`Compaction step failed: ${getErrorMessage(error)}`);
  }

  log("Rebuilding missing embeddings");
  try {
    const embeddingResult = await rebuildMissingEmbeddings(repository, config);
    log(
      `Embedding rebuild finished with ${embeddingResult.rebuilt} rebuilt and ${embeddingResult.failed} failed`
    );

    if (embeddingResult.failed > 0) {
      recordError(`Embedding regeneration failed for ${embeddingResult.failed} memories`);
    }
  } catch (error) {
    recordError(`Embedding rebuild step failed: ${getErrorMessage(error)}`);
  }

  log("Backfilling missing summaries");
  try {
    const summaryResult = await backfillSummaries(repository, memoryService, config);
    log(`Summary backfill: ${summaryResult.updated} updated, ${summaryResult.failed} failed`);
  } catch (error) {
    recordError(`Summary backfill failed: ${getErrorMessage(error)}`);
  }

  log("Exporting snapshot");
  try {
    const snapshotPath = getSnapshotPath(config);
    exportSnapshot(repository, snapshotPath);
    log(`Snapshot exported to ${snapshotPath}`);
  } catch (error) {
    recordError(`Snapshot export step failed: ${getErrorMessage(error)}`);
  }

  log("Cleaning old backups");
  try {
    cleanOldBackups(backupDir, config.backupRetentionDays);
    log(`Backup cleanup completed with retention ${config.backupRetentionDays} days`);
  } catch (error) {
    recordError(`Backup cleanup step failed: ${getErrorMessage(error)}`);
  }

  log("Checking graceful deletion lifecycle");
  try {
    if (notificationManager === undefined) {
      log("Graceful deletion skipped because notifications are unavailable");
    } else {
      const lifecycleManager = new LifecycleManager(
        repository,
        notificationManager,
        config
      );
      const pendingDeletionStatus = lifecycleManager.checkPendingDeletions();

      if (pendingDeletionStatus.pending.length === 0) {
        lifecycleManager.clearPendingDeletionTracking();
      }

      if (
        pendingDeletionStatus.pending.length > 0 &&
        !pendingDeletionStatus.userAcknowledged
      ) {
        await lifecycleManager.notifyPendingDeletions(pendingDeletionStatus.pending);
        preserveAlert = true;
        log(
          `Graceful deletion warning sent for ${pendingDeletionStatus.pending.length} archived memories`
        );
      }

      const deletionResult = lifecycleManager.executeDeletion();
      log(
        `Graceful deletion finished with ${deletionResult.deleted} deleted and ${deletionResult.blocked} blocked`
      );
    }
  } catch (error) {
    recordError(`Graceful deletion step failed: ${getErrorMessage(error)}`);
  }

  if (
    options.rssService &&
    options.contentFetcher &&
    options.contentDistiller &&
    options.pageManager
  ) {
    log("Polling RSS feeds");
    try {
      const result = await pollAllFeeds(
        options.rssService,
        options.contentFetcher,
        options.contentDistiller,
        options.pageManager,
        memoryService,
        config
      );

      log(
        `RSS polling finished with ${result.processed} new items across ${result.polled_feeds} feeds`
      );

      for (const error of result.errors) {
        recordError(error);
      }
    } catch (error) {
      recordError(`RSS polling step failed: ${getErrorMessage(error)}`);
    }
  }

  if (options.synthesisEngine) {
    log("Running wiki synthesis batch");
    try {
      const results = await options.synthesisEngine.synthesizeAll();

      if (options.crossReferenceService && options.pageManager) {
        for (const result of results) {
          if (result.action === "unchanged" || result.page_id.length === 0) {
            continue;
          }

          const page = options.pageManager.getPage(result.page_id);

          if (page) {
            options.crossReferenceService.updateCrossReferences(page);
          }
        }
      }

      log(`Wiki synthesis batch finished with ${results.length} candidate topics`);
    } catch (error) {
      recordError(`Wiki synthesis batch failed: ${getErrorMessage(error)}`);
    }
  }

  if (options.stalenessService) {
    log("Scanning for stale wiki pages");
    try {
      const stalePages = options.stalenessService.detectStalePages();
      let newlyMarked = 0;

      for (const page of stalePages) {
        if (page.status === "stale") {
          continue;
        }

        options.stalenessService.markStale(page.id);
        newlyMarked += 1;
      }

      log(
        `Staleness scan finished with ${stalePages.length} stale pages and ${newlyMarked} newly marked`
      );
    } catch (error) {
      recordError(`Staleness scan failed: ${getErrorMessage(error)}`);
    }
  }

  if (isReconciliationAutoEnabled()) {
    const reconciliationRunAt = now();
    const reconciliationWindowHours = resolveReconciliationWindowHours();

    if (shouldRunReconciliationForCurrentSchedule(new Date(reconciliationRunAt))) {
      log("Running reconciliation auto-trigger");

      try {
        const windowEnd = reconciliationRunAt;
        const windowStart = windowEnd - reconciliationWindowHours * HOUR_MS;
        const reconciliationResult = await runReconciliationStep({
          repository,
          window_start: windowStart,
          window_end: windowEnd,
          dimensions: DEFAULT_RECONCILIATION_DIMENSIONS
        });
        const alertInputs = toReconciliationAlertInputs(
          reconciliationResult,
          repository,
          windowStart,
          windowEnd
        );

        log(
          `reconciliation_complete ${JSON.stringify({
            run_id: reconciliationResult.run_id,
            totals: reconciliationResult.totals,
            dimensions: reconciliationResult.dimensions.map((dimension) => ({
              dimension: dimension.dimension,
              status: dimension.status
            }))
          })}`
        );
        log("vega_reconciliation_runs_total status=success count=1");

        const alerts = evaluateReconciliationAlerts(
          alertInputs,
          options.reconciliationAlertConfig
        );
        const alertBaseDir = join(getDataDir(config), "alerts", "reconciliation");
        const alertDispatcher =
          options.alertDispatcher ?? createPerDimensionAlertDispatcher(alertBaseDir);
        const dispatched = await dispatchReconciliationAlerts({
          alerts,
          alertDispatcher,
          notificationManager,
          cooldown: reconciliationAlertCooldown,
          cooldownMs: resolveReconciliationFlapCooldownMs(),
          now: reconciliationRunAt
        });

        if (dispatched > 0) {
          preserveAlert = true;
        }

        log(
          `Reconciliation alert evaluation finished with ${alerts.length} alerts and ${dispatched} dispatched`
        );
      } catch (error) {
        logError(`reconciliation_auto_trigger_failed: ${getErrorMessage(error)}`);
        log("vega_reconciliation_failures_total count=1");
      }
    } else {
      log("Reconciliation auto-trigger skipped because the configured cron does not match");
    }
  }

  const digestFlushed = await flushDailyDigestSafely(notificationManager);

  if (errors.length > 0) {
    await notifySafely(
      "Daily maintenance notification",
      notificationManager === undefined
        ? undefined
        : () =>
            notificationManager.notifyError(
              "Daily Maintenance Errors",
              formatDailyErrorDetail(errors)
            )
    );
    log(`Daily maintenance finished with ${errors.length} errors`);
    return;
  }

  if (!preserveAlert && !digestFlushed) {
    notificationManager?.clearAlert();
  }
  log("Daily maintenance finished");
}

export async function refreshWikiProjection(
  pageManager: PageManager,
  synthesisEngine: SynthesisEngine,
  crossReferenceService?: CrossReferenceService
): Promise<{ spaces_backfilled: number; synthesized: number }> {
  const spacesBackfilled = pageManager.ensureDefaultSpacesForPages();
  const results = await synthesisEngine.synthesizeAll();

  if (crossReferenceService) {
    for (const result of results) {
      if (result.action === "unchanged" || result.page_id.length === 0) {
        continue;
      }

      const page = pageManager.getPage(result.page_id);
      if (page) {
        crossReferenceService.updateCrossReferences(page);
      }
    }
  }

  return {
    spaces_backfilled: spacesBackfilled,
    synthesized: results.length
  };
}

export async function pollAllFeeds(
  rssService: RSSService,
  fetcher: ContentFetcher,
  distiller: ContentDistiller,
  pageManager: PageManager,
  memoryService: MemoryService,
  config: VegaConfig
): Promise<{ polled_feeds: number; processed: number; errors: string[] }> {
  const feeds = rssService.listFeeds();
  const errors: string[] = [];
  let processed = 0;

  for (const feed of feeds) {
    try {
      processed += await rssService.pollFeed(
        feed,
        fetcher,
        distiller,
        pageManager,
        memoryService,
        config
      );
    } catch (error) {
      errors.push(
        `RSS feed ${feed.id} (${feed.url}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return {
    polled_feeds: feeds.length,
    processed,
    errors
  };
}

export async function weeklyHealthReport(
  repository: Repository,
  config: VegaConfig,
  memoryService?: MemoryService,
  notificationManager?: NotificationManager
): Promise<void> {
  log("Weekly health report started");

  if (memoryService) {
    const insightGenerator = new InsightGenerator(repository, memoryService);
    const generated = await insightGenerator.generateInsights();
    log(`Insight generation finished with ${generated} new insights`);
  }

  const integrityRows = repository.db
    .prepare<[], IntegrityCheckRow>("PRAGMA integrity_check")
    .all();
  const integrityResult = integrityRows.map((row) => row.integrity_check).join(", ");
  const typeCounts = repository.db
    .prepare<[], CountRow<MemoryType>>(
      `SELECT type AS name, COUNT(*) AS count
       FROM memories
       GROUP BY type
       ORDER BY count DESC, name ASC`
    )
    .all();
  const statusCounts = repository.db
    .prepare<[], CountRow<MemoryStatus>>(
      `SELECT status AS name, COUNT(*) AS count
       FROM memories
       GROUP BY status
       ORDER BY count DESC, name ASC`
    )
    .all();
  const now = Date.now();
  const weekCutoff = new Date(now - 7 * DAY_MS).toISOString();
  const staleCutoff = new Date(now - 30 * DAY_MS).toISOString();
  const latencyRow = repository.db
    .prepare<[string], AverageLatencyRow>(
      `SELECT AVG(latency_ms) AS average_latency, COUNT(*) AS entry_count
       FROM performance_log
       WHERE timestamp >= ?`
    )
    .get(weekCutoff);
  const recentlyAccessedRow = repository.db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM memories WHERE accessed_at >= ?"
    )
    .get(staleCutoff);
  const staleRow = repository.db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM memories WHERE accessed_at <= ?"
    )
    .get(staleCutoff);
  const unverifiedRow = repository.db
    .prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM memories WHERE verified = 'unverified'"
    )
    .get();
  const archivedRow = repository.db
    .prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM memories WHERE status = 'archived'"
    )
    .get();
  const activeRow = repository.db
    .prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM memories WHERE status = 'active'"
    )
    .get();
  const newThisWeekRow = repository.db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM memories WHERE created_at >= ?"
    )
    .get(weekCutoff);
  const totalRow = repository.db
    .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM memories")
    .get();
  const topAccessed = repository.db
    .prepare<[], TopAccessedMemoryRow>(
      `SELECT id, title, access_count, accessed_at
       FROM memories
       ORDER BY access_count DESC, accessed_at DESC, title ASC
       LIMIT 5`
    )
    .all();
  const generatedAt = timestamp();
  const averageLatency = latencyRow?.average_latency ?? 0;
  const latencyEntryCount = latencyRow?.entry_count ?? 0;
  const recentlyAccessedCount = recentlyAccessedRow?.count ?? 0;
  const staleCount = staleRow?.count ?? 0;
  const unverifiedCount = unverifiedRow?.count ?? 0;
  const archivedCount = archivedRow?.count ?? 0;
  const activeCount = activeRow?.count ?? 0;
  const newThisWeekCount = newThisWeekRow?.count ?? 0;
  const totalCount = totalRow?.count ?? 0;
  const reportPath = getWeeklyReportPath(config);
  const content = [
    "# Weekly Health Report",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Integrity Check",
    "",
    `- Result: ${integrityResult}`,
    `- Total memories: ${totalCount}`,
    `- Not accessed in 30+ days: ${staleCount}`,
    "",
    "## Performance Trends",
    "",
    `- Average latency over past 7 days: ${averageLatency.toFixed(2)} ms`,
    `- Performance samples over past 7 days: ${latencyEntryCount}`,
    "",
    "## Memory Quality",
    "",
    `- Accessed in last 30 days: ${formatPercent(recentlyAccessedCount, totalCount)}% (${recentlyAccessedCount}/${totalCount})`,
    `- Unverified: ${formatPercent(unverifiedCount, totalCount)}% (${unverifiedCount}/${totalCount})`,
    `- Archived: ${formatPercent(archivedCount, totalCount)}% (${archivedCount}/${totalCount})`,
    "",
    "## Growth Stats",
    "",
    `- New memories this week: ${newThisWeekCount}`,
    `- Total active: ${activeCount}`,
    `- Total archived: ${archivedCount}`,
    "",
    formatTopAccessedTable(topAccessed),
    formatCountTable("Memories by Type", typeCounts),
    formatCountTable("Memories by Status", statusCounts)
  ].join("\n");

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, content, "utf8");

  log(
    `Weekly health report written to ${reportPath} (integrity=${integrityResult}, total=${totalCount}, stale=${staleCount})`
  );

  await notifySafely(
    "Weekly health report notification",
    notificationManager === undefined
      ? undefined
      : () =>
          notificationManager.notifyWeekly(
            formatWeeklySummary(generatedAt, integrityResult, totalCount, staleCount)
          )
  );
}

export async function monitorOllamaAvailability(
  config: VegaConfig,
  notificationManager: NotificationManager
): Promise<void> {
  const available = await isOllamaAvailable(config);

  if (available) {
    if (ollamaDownSince !== null) {
      log("Ollama availability restored");
    }

    ollamaDownSince = null;
    ollamaWarningSent = false;
    return;
  }

  if (ollamaDownSince === null) {
    ollamaDownSince = Date.now();
    log("Ollama is unavailable; tracking downtime");
    return;
  }

  if (ollamaWarningSent || Date.now() - ollamaDownSince < HOUR_MS) {
    return;
  }

  ollamaWarningSent = true;
  const downSince = ollamaDownSince;

  await notifySafely(
    "Ollama warning notification",
    () =>
      // TODO: batch warnings into the daily digest once scheduler digests are implemented.
      notificationManager.notifyWarning(
        "Ollama Unavailable",
        `Ollama has been unreachable for more than 1 hour since ${new Date(downSince).toISOString()}.`
      )
  );
  log("Ollama downtime warning sent");
}
