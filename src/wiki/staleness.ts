import { Repository } from "../db/repository.js";
import { PageManager } from "./page-manager.js";
import type { WikiPage } from "./types.js";

interface TaggedMemoryRow {
  tags: string;
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function hasSharedTags(pageTags: string[], memoryTags: string[]): boolean {
  const normalizedPageTags = new Set(pageTags.map((tag) => tag.toLowerCase()));
  return memoryTags.some((tag) => normalizedPageTags.has(tag.toLowerCase()));
}

export class StalenessService {
  constructor(
    private readonly pageManager: PageManager,
    private readonly repository: Repository
  ) {}

  detectStalePages(memoryStalenessThreshold = 5, daysSinceReview?: number): WikiPage[] {
    const threshold = normalizePositiveInteger(memoryStalenessThreshold, 5);
    const stalePages = new Map(
      this.pageManager
        .findStalePages(undefined, daysSinceReview)
        .map((page) => [page.id, page] as const)
    );
    const publishedPages = this.pageManager.listPages({
      status: "published",
      limit: Number.MAX_SAFE_INTEGER
    });

    for (const page of publishedPages) {
      if (stalePages.has(page.id) || page.tags.length === 0) {
        continue;
      }

      if (this.countNewTaggedMemories(page) >= threshold) {
        stalePages.set(page.id, page);
      }
    }

    return Array.from(stalePages.values()).sort((left, right) =>
      left.updated_at.localeCompare(right.updated_at)
    );
  }

  markStale(pageId: string): void {
    const page = this.pageManager.getPage(pageId);

    if (!page) {
      throw new Error(`Wiki page not found: ${pageId}`);
    }

    if (page.status === "stale") {
      return;
    }

    this.pageManager.updatePage(pageId, { status: "stale" }, "Marked page as stale");
  }

  getStalePageSummary(): { total: number; byProject: Record<string, number> } {
    const stalePages = this.pageManager.listPages({
      status: "stale",
      limit: Number.MAX_SAFE_INTEGER
    });
    const byProject: Record<string, number> = {};

    for (const page of stalePages) {
      const projectKey = page.project ?? "global";
      byProject[projectKey] = (byProject[projectKey] ?? 0) + 1;
    }

    return {
      total: stalePages.length,
      byProject
    };
  }

  private countNewTaggedMemories(page: WikiPage): number {
    const params: unknown[] = [page.updated_at];
    let query = "SELECT tags FROM memories WHERE status = 'active' AND created_at > ?";

    if (page.scope === "global") {
      query += " AND scope = 'global'";
    } else if (page.project) {
      query += " AND (project = ? OR scope = 'global')";
      params.push(page.project);
    }

    const rows = this.repository.db.prepare<unknown[], TaggedMemoryRow>(query).all(...params);

    return rows.reduce((count, row) => {
      return hasSharedTags(page.tags, parseJsonArray(row.tags)) ? count + 1 : count;
    }, 0);
  }
}
