import type { VegaConfig } from "../config.js";
import { Repository } from "../db/repository.js";
import { NotificationManager } from "../notify/manager.js";
import type { GracefulDeletionStatus, Memory } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTICE_AFTER_DAYS = 83;
const DELETE_AFTER_DAYS = 90;
const EXTENSION_DAYS = 3;
const MAX_EXTENSIONS = 2;
const PENDING_NOTIFICATION_METADATA_KEY = "lifecycle.pending_deletions.notified_at";
export const ARCHIVED_EXPORT_METADATA_KEY = "lifecycle.archived_exported_at";
const EXTENSION_COUNTS_METADATA_KEY = "lifecycle.pending_deletions.extensions";

type ExtensionCounts = Record<string, number>;

const now = (): string => new Date().toISOString();

const parseTimestamp = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isArchivedBefore = (memory: Memory, cutoffMs: number): boolean => {
  const updatedAt = Date.parse(memory.updated_at);
  return Number.isFinite(updatedAt) && updatedAt <= cutoffMs;
};

export class LifecycleManager {
  constructor(
    private readonly repository: Repository,
    private readonly notificationManager: NotificationManager,
    private readonly _config: VegaConfig
  ) {}

  private listArchivedMemories(): Memory[] {
    return this.repository.listMemories({
      status: "archived",
      limit: 1_000_000,
      sort: "updated_at ASC"
    });
  }

  private readExtensionCounts(): ExtensionCounts {
    const stored = this.repository.getMetadata(EXTENSION_COUNTS_METADATA_KEY);

    if (stored === null) {
      return {};
    }

    try {
      const parsed = JSON.parse(stored) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }

      return Object.fromEntries(
        Object.entries(parsed).flatMap(([key, value]) =>
          typeof value === "number" && Number.isInteger(value) && value >= 0
            ? [[key, value]]
            : []
        )
      );
    } catch {
      return {};
    }
  }

  private writeExtensionCounts(extensionCounts: ExtensionCounts): void {
    const entries = Object.entries(extensionCounts).filter(([, count]) => count > 0);

    if (entries.length === 0) {
      this.repository.deleteMetadata(EXTENSION_COUNTS_METADATA_KEY);
      return;
    }

    this.repository.setMetadata(
      EXTENSION_COUNTS_METADATA_KEY,
      JSON.stringify(Object.fromEntries(entries))
    );
  }

  private getDeletionDeadline(memory: Memory, extensionCount: number): number {
    return (
      Date.parse(memory.updated_at) +
      (DELETE_AFTER_DAYS + extensionCount * EXTENSION_DAYS) * DAY_MS
    );
  }

  private hasArchivedExportSinceNotification(): boolean {
    const notifiedAt = parseTimestamp(
      this.repository.getMetadata(PENDING_NOTIFICATION_METADATA_KEY)
    );
    const exportedAt = parseTimestamp(
      this.repository.getMetadata(ARCHIVED_EXPORT_METADATA_KEY)
    );

    return (
      notifiedAt !== null &&
      exportedAt !== null &&
      exportedAt >= notifiedAt
    );
  }

  checkPendingDeletions(): GracefulDeletionStatus {
    const extensionCounts = this.readExtensionCounts();
    const pending = this.listArchivedMemories().filter(
      (memory) =>
        memory.source !== "explicit" &&
        isArchivedBefore(memory, Date.now() - NOTICE_AFTER_DAYS * DAY_MS)
    );
    const nextDeadline =
      pending.length === 0
        ? null
        : Math.min(
            ...pending.map((memory) =>
              this.getDeletionDeadline(memory, extensionCounts[memory.id] ?? 0)
            )
          );

    return {
      pending,
      daysUntilDeletion:
        nextDeadline === null
          ? 0
          : Math.max(0, Math.ceil((nextDeadline - Date.now()) / DAY_MS)),
      userAcknowledged: this.hasArchivedExportSinceNotification()
    };
  }

  async notifyPendingDeletions(memories: Memory[]): Promise<void> {
    if (memories.length === 0) {
      return;
    }

    await this.notificationManager.notifyWarning(
      "Pending Deletions",
      `${memories.length} memories will be cleaned in 7 days. Run: vega export --archived --before 90d`
    );
    this.repository.setMetadata(PENDING_NOTIFICATION_METADATA_KEY, now());
  }

  executeDeletion(): { deleted: number; blocked: number } {
    const extensionCounts = this.readExtensionCounts();
    const exportedSinceNotification = this.hasArchivedExportSinceNotification();
    let deleted = 0;
    let blocked = 0;
    let extensionCountsChanged = false;

    for (const memory of this.listArchivedMemories()) {
      const updatedAt = Date.parse(memory.updated_at);

      if (!Number.isFinite(updatedAt) || updatedAt > Date.now() - DELETE_AFTER_DAYS * DAY_MS) {
        continue;
      }

      if (memory.source === "explicit") {
        blocked += 1;
        continue;
      }

      const extensionCount = extensionCounts[memory.id] ?? 0;
      const deletionDeadline = this.getDeletionDeadline(memory, extensionCount);

      if (Date.now() < deletionDeadline) {
        continue;
      }

      if (exportedSinceNotification) {
        this.repository.deleteMemory(memory.id);
        delete extensionCounts[memory.id];
        extensionCountsChanged = true;
        deleted += 1;
        continue;
      }

      if (extensionCount < MAX_EXTENSIONS) {
        extensionCounts[memory.id] = extensionCount + 1;
        extensionCountsChanged = true;
      }

      blocked += 1;
    }

    if (extensionCountsChanged) {
      this.writeExtensionCounts(extensionCounts);
    }

    if (deleted > 0 && exportedSinceNotification) {
      this.repository.deleteMetadata(PENDING_NOTIFICATION_METADATA_KEY);
      this.repository.deleteMetadata(ARCHIVED_EXPORT_METADATA_KEY);
    }

    return { deleted, blocked };
  }
}
