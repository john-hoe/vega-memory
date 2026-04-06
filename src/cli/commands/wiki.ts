import { resolve } from "node:path";

import { Command, Option } from "commander";

import { expandHomePath } from "../../config.js";
import { StaticExporter } from "../../publishing/static-export.js";
import {
  publishWikiPages,
  type WikiPublishTarget
} from "../../publishing/service.js";
import type { Repository } from "../../db/repository.js";
import { CrossReferenceService } from "../../wiki/cross-reference.js";
import { PageManager } from "../../wiki/page-manager.js";
import { reviewWikiPage } from "../../wiki/review.js";
import { searchWikiPages, type WikiSearchResult } from "../../wiki/search.js";
import { SynthesisEngine, type SynthesizeResult } from "../../wiki/synthesis.js";
import { StalenessService } from "../../wiki/staleness.js";
import {
  WIKI_PAGE_STATUSES,
  WIKI_PAGE_TYPES,
  type PageWithBacklinks,
  type WikiPage,
  type WikiPageListFilters,
  type WikiPageStatus,
  type WikiPageType
} from "../../wiki/types.js";

interface WikiPageListEntry {
  id: string;
  slug: string;
  title: string;
  page_type: WikiPageType;
  status: WikiPageStatus;
  updated_at: string;
}

interface WikiStats {
  total_pages: number;
  by_type: Array<{ name: string; count: number }>;
  by_status: Array<{ name: string; count: number }>;
  by_project: Array<{ name: string; count: number }>;
  draft_pages: number;
  stale_pages: number;
  orphan_pages: number;
}

const WIKI_PUBLISH_TARGETS = [
  "notion",
  "obsidian",
  "all"
] as const satisfies readonly WikiPublishTarget[];
const WIKI_EXPORT_FORMATS = ["obsidian", "markdown"] as const;

const countBy = (values: string[]): Array<{ name: string; count: number }> => {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
};

const serializeWikiPage = (page: WikiPage): WikiPageListEntry => ({
  id: page.id,
  slug: page.slug,
  title: page.title,
  page_type: page.page_type,
  status: page.status,
  updated_at: page.updated_at
});

const syncCrossReferencesForResult = (
  pageManager: PageManager,
  crossReferenceService: CrossReferenceService,
  result: SynthesizeResult
): void => {
  if (result.action === "unchanged" || result.page_id.length === 0) {
    return;
  }

  const page = pageManager.getPage(result.page_id);

  if (page) {
    crossReferenceService.updateCrossReferences(page);
  }
};

const printPageTable = (pages: WikiPageListEntry[]): void => {
  console.table(
    pages.map((page) => ({
      id: page.id,
      slug: page.slug,
      title: page.title,
      page_type: page.page_type,
      status: page.status,
      updated_at: page.updated_at
    }))
  );
};

const printSearchTable = (results: WikiSearchResult[]): void => {
  console.table(
    results.map((result) => ({
      id: result.id,
      slug: result.slug,
      title: result.title,
      summary: result.summary,
      page_type: result.page_type,
      status: result.status,
      updated_at: result.updated_at
    }))
  );
};

const printReadResult = (result: PageWithBacklinks): void => {
  console.log(`id: ${result.page.id}`);
  console.log(`slug: ${result.page.slug}`);
  console.log(`title: ${result.page.title}`);
  console.log(`page_type: ${result.page.page_type}`);
  console.log(`status: ${result.page.status}`);
  console.log(`updated_at: ${result.page.updated_at}`);
  console.log("");
  console.log(result.page.content);
  console.log("");
  console.log("backlinks:");

  if (result.backlinks.length === 0) {
    console.log("none");
    return;
  }

  for (const backlink of result.backlinks) {
    console.log(`${backlink.slug}\t${backlink.context}`);
  }
};

const printSynthesisResult = (result: SynthesizeResult): void => {
  console.log(`page_id: ${result.page_id}`);
  console.log(`slug: ${result.slug}`);
  console.log(`action: ${result.action}`);
  console.log(`memories_used: ${result.memories_used}`);
};

const printWikiStats = (stats: WikiStats): void => {
  console.log(`total pages: ${stats.total_pages}`);
  console.log(`draft pages: ${stats.draft_pages}`);
  console.log(`stale pages: ${stats.stale_pages}`);
  console.log(`orphan pages: ${stats.orphan_pages}`);
  console.log("by type:");
  console.table(stats.by_type);
  console.log("by status:");
  console.table(stats.by_status);
  console.log("by project:");
  console.table(stats.by_project);
};

export const listWikiPages = (
  pageManager: PageManager,
  filters: WikiPageListFilters
): WikiPageListEntry[] => pageManager.listPages(filters).map(serializeWikiPage);

export const readWikiPage = (
  pageManager: PageManager,
  slug: string
): PageWithBacklinks => {
  const result = pageManager.getPageWithBacklinks(slug);

  if (!result) {
    throw new Error(`Wiki page not found: ${slug}`);
  }

  return result;
};

export const synthesizeWikiTopic = async (
  synthesisEngine: SynthesisEngine,
  pageManager: PageManager,
  crossReferenceService: CrossReferenceService,
  topic: string,
  project?: string,
  force = false
): Promise<SynthesizeResult> => {
  const result = await synthesisEngine.synthesize(topic, project, force);

  syncCrossReferencesForResult(pageManager, crossReferenceService, result);

  return result;
};

export const synthesizeAllWikiPages = async (
  synthesisEngine: SynthesisEngine,
  pageManager: PageManager,
  crossReferenceService: CrossReferenceService,
  project?: string
): Promise<SynthesizeResult[]> => {
  const results = await synthesisEngine.synthesizeAll(project);

  results.forEach((result) => {
    syncCrossReferencesForResult(pageManager, crossReferenceService, result);
  });

  return results;
};

export const listDraftWikiPages = (pageManager: PageManager): WikiPageListEntry[] =>
  listWikiPages(pageManager, {
    status: "draft",
    limit: Number.MAX_SAFE_INTEGER
  });

export const listStaleWikiPages = (
  stalenessService: StalenessService
): WikiPageListEntry[] => stalenessService.detectStalePages().map(serializeWikiPage);

export const getWikiStats = (
  pageManager: PageManager,
  crossReferenceService: CrossReferenceService,
  stalenessService: StalenessService
): WikiStats => {
  const pages = pageManager.listPages({ limit: Number.MAX_SAFE_INTEGER });

  return {
    total_pages: pages.length,
    by_type: countBy(pages.map((page) => page.page_type)),
    by_status: countBy(pages.map((page) => page.status)),
    by_project: countBy(pages.map((page) => page.project ?? "global")),
    draft_pages: pages.filter((page) => page.status === "draft").length,
    stale_pages: stalenessService.detectStalePages().length,
    orphan_pages: crossReferenceService.findOrphanPages().length
  };
};

export function registerWikiCommand(
  program: Command,
  repository: Repository,
  pageManager: PageManager,
  synthesisEngine: SynthesisEngine,
  crossReferenceService: CrossReferenceService,
  stalenessService: StalenessService
): void {
  const wikiCommand = program.command("wiki").description("Manage wiki pages");

  wikiCommand
    .command("list")
    .description("List wiki pages")
    .option("--project <project>", "project name")
    .addOption(new Option("--type <type>", "page type").choices([...WIKI_PAGE_TYPES]))
    .addOption(new Option("--status <status>", "page status").choices([...WIKI_PAGE_STATUSES]))
    .option("--json", "print JSON")
    .action(
      (options: {
        project?: string;
        type?: WikiPageType;
        status?: WikiPageStatus;
        json?: boolean;
      }) => {
        const result = listWikiPages(pageManager, {
          project: options.project,
          page_type: options.type,
          status: options.status
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.length === 0) {
          console.log("No wiki pages found.");
          return;
        }

        printPageTable(result);
      }
    );

  wikiCommand
    .command("read")
    .description("Read a wiki page")
    .argument("<slug>", "page slug or id")
    .option("--json", "print JSON")
    .action(async (slug: string, options: { json?: boolean }) => {
      const result = readWikiPage(pageManager, slug);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printReadResult(result);
    });

  wikiCommand
    .command("search")
    .description("Search wiki pages")
    .argument("<query>", "search query")
    .option("--project <project>", "project name")
    .option("--json", "print JSON")
    .action(
      (
        query: string,
        options: {
          project?: string;
          json?: boolean;
        }
      ) => {
        const result = searchWikiPages(repository, {
          query,
          project: options.project,
          limit: 10
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.length === 0) {
          console.log("No wiki pages found.");
          return;
        }

        printSearchTable(result);
      }
    );

  wikiCommand
    .command("synthesize")
    .description("Synthesize wiki pages from memories")
    .option("--topic <topic>", "topic to synthesize")
    .option("--project <project>", "project name")
    .option("--force", "force synthesis even with fewer than 3 memories")
    .option("--all", "synthesize all candidate topics")
    .option("--json", "print JSON")
    .action(
      async (options: {
        topic?: string;
        project?: string;
        force?: boolean;
        all?: boolean;
        json?: boolean;
      }) => {
        if (options.all === true && options.topic !== undefined) {
          throw new Error("Use either --topic or --all");
        }

        if (options.all !== true && options.topic === undefined) {
          throw new Error("Provide --topic or use --all");
        }

        if (options.all) {
          const results = await synthesizeAllWikiPages(
            synthesisEngine,
            pageManager,
            crossReferenceService,
            options.project
          );

          if (options.json) {
            console.log(JSON.stringify(results, null, 2));
            return;
          }

          if (results.length === 0) {
            console.log("No wiki synthesis candidates found.");
            return;
          }

          console.table(results);
          return;
        }

        const result = await synthesizeWikiTopic(
          synthesisEngine,
          pageManager,
          crossReferenceService,
          options.topic as string,
          options.project,
          options.force ?? false
        );

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        printSynthesisResult(result);
      }
    );

  wikiCommand
    .command("review")
    .description("Approve or reject a wiki page")
    .argument("<slug>", "page slug or id")
    .option("--approve", "approve the page")
    .option("--reject", "reject the page")
    .option("--json", "print JSON")
    .action(
      (
        slug: string,
        options: {
          approve?: boolean;
          reject?: boolean;
          json?: boolean;
        }
      ) => {
        if (options.approve === options.reject) {
          throw new Error("Provide exactly one of --approve or --reject");
        }

        const result = reviewWikiPage(
          pageManager,
          crossReferenceService,
          slug,
          options.approve ? "approve" : "reject"
        );

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`${result.new_status} ${result.page_id}`);
      }
    );

  wikiCommand
    .command("publish")
    .description("Publish wiki pages to Notion or Obsidian")
    .option("--slug <slug>", "page slug or id")
    .option("--all", "publish all published pages")
    .addOption(new Option("--target <target>", "publish target").choices([...WIKI_PUBLISH_TARGETS]).makeOptionMandatory())
    .option("--json", "print JSON")
    .action(
      async (options: {
        slug?: string;
        all?: boolean;
        target: WikiPublishTarget;
        json?: boolean;
      }) => {
        const result = await publishWikiPages(pageManager, {
          slug: options.slug,
          all: options.all ?? false,
          target: options.target
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`published_count: ${result.published_count}`);
        console.log(`target: ${result.target}`);

        if (result.errors.length > 0) {
          console.log("errors:");
          result.errors.forEach((error) => console.log(error));
        }
      }
    );

  wikiCommand
    .command("export")
    .description("Export published wiki pages as static Markdown")
    .addOption(new Option("--format <format>", "export format").choices([...WIKI_EXPORT_FORMATS]).makeOptionMandatory())
    .requiredOption("--output <dir>", "output directory")
    .option("--json", "print JSON")
    .action(
      (options: {
        format: "obsidian" | "markdown";
        output: string;
        json?: boolean;
      }) => {
        const exporter = new StaticExporter(pageManager);
        const result = exporter.exportAll(
          resolve(expandHomePath(options.output)),
          options.format
        );

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`exported ${result.exported} wiki pages to ${result.outputDir}`);
      }
    );

  wikiCommand
    .command("drafts")
    .description("List draft wiki pages")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const result = listDraftWikiPages(pageManager);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.length === 0) {
        console.log("No draft wiki pages found.");
        return;
      }

      printPageTable(result);
    });

  wikiCommand
    .command("stale")
    .description("List stale wiki pages")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const result = listStaleWikiPages(stalenessService);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.length === 0) {
        console.log("No stale wiki pages found.");
        return;
      }

      printPageTable(result);
    });

  wikiCommand
    .command("stats")
    .description("Show wiki page statistics")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const result = getWikiStats(pageManager, crossReferenceService, stalenessService);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printWikiStats(result);
    });
}
