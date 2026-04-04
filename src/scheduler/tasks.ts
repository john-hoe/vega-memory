import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { LifecycleManager } from "../core/lifecycle.js";
import { MemoryService } from "../core/memory.js";
import { exportSnapshot } from "../core/snapshot.js";
import type { MemoryStatus, MemoryType } from "../core/types.js";
import { cleanOldBackups, createBackup, shouldBackup } from "../db/backup.js";
import { Repository } from "../db/repository.js";
import { generateEmbedding, isOllamaAvailable } from "../embedding/ollama.js";
import { InsightGenerator } from "../insights/generator.js";
import type { NotificationManager } from "../notify/manager.js";
import { resolveConfiguredEncryptionKey } from "../security/keychain.js";

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

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

let ollamaDownSince: number | null = null;
let ollamaWarningSent = false;

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

export async function dailyMaintenance(
  repository: Repository,
  compactService: CompactService,
  config: VegaConfig,
  notificationManager?: NotificationManager
): Promise<void> {
  const backupDir = getBackupDir(config);
  const errors: string[] = [];
  let preserveAlert = false;
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
        await resolveConfiguredEncryptionKey(config)
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

  if (!preserveAlert) {
    notificationManager?.clearAlert();
  }
  log("Daily maintenance finished");
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
