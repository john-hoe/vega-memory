import { expandHomePath } from "../config.js";
import { PageManager } from "../wiki/page-manager.js";
import { NotionPublisher } from "./notion.js";
import { ObsidianPublisher } from "./obsidian.js";

export type WikiPublishTarget = "all" | "notion" | "obsidian";

export interface WikiPublishOptions {
  slug?: string;
  target: WikiPublishTarget;
  all?: boolean;
}

export interface WikiPublishResult {
  published_count: number;
  target: WikiPublishTarget;
  errors: string[];
}

const DEFAULT_OBSIDIAN_VAULT = "~/.vega/obsidian-vault";

const createObsidianPublisher = (pageManager: PageManager): ObsidianPublisher =>
  new ObsidianPublisher(
    pageManager,
    expandHomePath(process.env.VEGA_OBSIDIAN_VAULT ?? DEFAULT_OBSIDIAN_VAULT)
  );

const createNotionPublisher = (pageManager: PageManager): NotionPublisher =>
  new NotionPublisher(pageManager, {
    apiKey: process.env.VEGA_NOTION_API_KEY ?? "",
    databaseId: process.env.VEGA_NOTION_DB_ID ?? ""
  });

export const publishWikiPages = async (
  pageManager: PageManager,
  options: WikiPublishOptions
): Promise<WikiPublishResult> => {
  if (options.all === true && options.slug !== undefined) {
    throw new Error("Use either --slug or --all");
  }

  if (options.all !== true && options.slug === undefined) {
    throw new Error("Provide --slug or use --all");
  }

  const errors: string[] = [];
  let publishedCount = 0;

  if (options.all) {
    if (options.target === "obsidian" || options.target === "all") {
      try {
        const result = createObsidianPublisher(pageManager).publishAll();
        publishedCount += result.published;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (options.target === "notion" || options.target === "all") {
      try {
        const result = await createNotionPublisher(pageManager).publishAll();
        publishedCount += result.published;
        errors.push(...result.errors);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      published_count: publishedCount,
      target: options.target,
      errors
    };
  }

  const page = pageManager.getPage(options.slug as string);

  if (!page) {
    throw new Error(`Wiki page not found: ${options.slug}`);
  }

  if (options.target === "obsidian" || options.target === "all") {
    try {
      createObsidianPublisher(pageManager).publishPage(page);
      publishedCount += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (options.target === "notion" || options.target === "all") {
    try {
      await createNotionPublisher(pageManager).publishPage(page);
      publishedCount += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    published_count: publishedCount,
    target: options.target,
    errors
  };
};
