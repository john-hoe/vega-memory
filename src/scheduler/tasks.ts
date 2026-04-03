import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { VegaConfig } from "../config.js";
import { CompactService } from "../core/compact.js";
import { exportSnapshot } from "../core/snapshot.js";
import type { MemoryStatus, MemoryType } from "../core/types.js";
import { cleanOldBackups, createBackup, shouldBackup } from "../db/backup.js";
import { Repository } from "../db/repository.js";
import { generateEmbedding } from "../embedding/ollama.js";

interface CountRow<TName extends string> {
  name: TName;
  count: number;
}

interface IntegrityCheckRow {
  integrity_check: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const timestamp = (): string => new Date().toISOString();

const log = (message: string): void => {
  console.log(`[${timestamp()}] ${message}`);
};

const formatDate = (value: Date): string => value.toISOString().slice(0, 10);

const getDataDir = (config: VegaConfig): string =>
  config.dbPath === ":memory:" ? resolve(process.cwd(), "data") : dirname(resolve(config.dbPath));

const getBackupDir = (config: VegaConfig): string => join(getDataDir(config), "backups");

const getSnapshotPath = (config: VegaConfig): string =>
  join(getDataDir(config), "snapshots", `snapshot-${formatDate(new Date())}.md`);

const getWeeklyReportPath = (config: VegaConfig): string =>
  join(getDataDir(config), "reports", `weekly-${formatDate(new Date())}.md`);

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
  config: VegaConfig
): Promise<void> {
  const backupDir = getBackupDir(config);

  log("Daily maintenance started");

  log("Checking backup status");
  if (config.dbPath === ":memory:") {
    log("Backup skipped because the database is in-memory");
  } else if (shouldBackup(backupDir)) {
    await createBackup(config.dbPath, backupDir);
    log(`Backup created in ${backupDir}`);
  } else {
    log("Backup skipped because a recent backup already exists");
  }

  log("Running compaction");
  const compactResult = compactService.compact();
  log(
    `Compaction finished with ${compactResult.merged} merged and ${compactResult.archived} archived`
  );

  log("Rebuilding missing embeddings");
  const embeddingResult = await rebuildMissingEmbeddings(repository, config);
  log(
    `Embedding rebuild finished with ${embeddingResult.rebuilt} rebuilt and ${embeddingResult.failed} failed`
  );

  log("Exporting snapshot");
  const snapshotPath = getSnapshotPath(config);
  exportSnapshot(repository, snapshotPath);
  log(`Snapshot exported to ${snapshotPath}`);

  log("Cleaning old backups");
  cleanOldBackups(backupDir, config.backupRetentionDays);
  log(`Backup cleanup completed with retention ${config.backupRetentionDays} days`);

  log("Daily maintenance finished");
}

export async function weeklyHealthReport(
  repository: Repository,
  config: VegaConfig
): Promise<void> {
  log("Weekly health report started");

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
  const staleCutoff = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const staleRow = repository.db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM memories WHERE accessed_at <= ?"
    )
    .get(staleCutoff);
  const totalRow = repository.db
    .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM memories")
    .get();
  const staleCount = staleRow?.count ?? 0;
  const totalCount = totalRow?.count ?? 0;
  const reportPath = getWeeklyReportPath(config);
  const content = [
    "# Weekly Health Report",
    "",
    `Generated: ${timestamp()}`,
    "",
    "## Integrity Check",
    "",
    `- Result: ${integrityResult}`,
    `- Total memories: ${totalCount}`,
    `- Not accessed in 30+ days: ${staleCount}`,
    "",
    formatCountTable("Memories by Type", typeCounts),
    formatCountTable("Memories by Status", statusCounts)
  ].join("\n");

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, content, "utf8");

  log(
    `Weekly health report written to ${reportPath} (integrity=${integrityResult}, total=${totalCount}, stale=${staleCount})`
  );
}
