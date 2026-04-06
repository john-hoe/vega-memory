import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PageManager } from "../wiki/page-manager.js";
import type { WikiPage, WikiPageStatus } from "../wiki/types.js";
import {
  buildIndexDocument,
  buildPublishedDocument,
  getPageOutputPath
} from "./shared.js";

interface ObsidianPublishFilters {
  project?: string;
  status?: WikiPageStatus;
}

const timestamp = (): string => new Date().toISOString();

export class ObsidianPublisher {
  constructor(
    private readonly pageManager: PageManager,
    private readonly vaultPath: string
  ) {}

  publishPage(page: WikiPage): string {
    const relativePath = getPageOutputPath(page);
    const filePath = join(this.vaultPath, relativePath);
    const publishedPage = this.pageManager.updatePage(
      page.id,
      { published_at: timestamp() },
      "Published wiki page to Obsidian"
    );

    mkdirSync(this.vaultPath, { recursive: true });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, buildPublishedDocument(publishedPage), "utf8");

    return filePath;
  }

  publishAll(filters: ObsidianPublishFilters = {}): { published: number; paths: string[] } {
    const pages = this.pageManager.listPages({
      project: filters.project,
      status: filters.status ?? "published",
      limit: Number.MAX_SAFE_INTEGER
    });
    const paths = pages.map((page) => this.publishPage(page));

    mkdirSync(this.vaultPath, { recursive: true });
    writeFileSync(join(this.vaultPath, "index.md"), this.generateIndex(pages), "utf8");

    return {
      published: pages.length,
      paths
    };
  }

  generateIndex(pages: WikiPage[]): string {
    return buildIndexDocument(pages, (page) => `[[${page.slug}]]`);
  }
}
