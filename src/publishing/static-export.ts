import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PageManager } from "../wiki/page-manager.js";
import type { WikiPage } from "../wiki/types.js";
import {
  buildIndexDocument,
  buildPublishedDocument,
  getPageOutputPath,
  replaceWikiLinksWithMarkdown
} from "./shared.js";

export class StaticExporter {
  constructor(private readonly pageManager: PageManager) {}

  exportAll(
    outputDir: string,
    format: "obsidian" | "markdown"
  ): { exported: number; outputDir: string } {
    const pages = this.pageManager.listPages({
      status: "published",
      limit: Number.MAX_SAFE_INTEGER
    });
    const pagesBySlug = new Map(pages.map((page) => [page.slug, page] as const));

    mkdirSync(outputDir, { recursive: true });

    for (const page of pages) {
      const outputPath = join(outputDir, getPageOutputPath(page));
      const content =
        format === "obsidian"
          ? page.content
          : replaceWikiLinksWithMarkdown(page.content, page, pagesBySlug);

      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, buildPublishedDocument(page, content), "utf8");
    }

    writeFileSync(
      join(outputDir, "index.md"),
      buildIndexDocument(
        pages,
        (page: WikiPage) =>
          format === "obsidian"
            ? `[[${page.slug}]]`
            : `[${page.title}](./${getPageOutputPath(page).replace(/\\/g, "/")})`
      ),
      "utf8"
    );

    return {
      exported: pages.length,
      outputDir
    };
  }
}
