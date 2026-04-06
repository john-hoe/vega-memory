import { dirname, relative } from "node:path";

import {
  WIKI_PAGE_TYPES,
  type WikiPage,
  type WikiPageType
} from "../wiki/types.js";

const PAGE_TYPE_DIRECTORIES: Record<WikiPageType, string> = {
  project: "projects",
  decision_log: "decision-logs",
  pitfall_guide: "pitfall-guides",
  runbook: "runbooks",
  reference: "references",
  topic: "topics"
};

const PAGE_TYPE_TITLES: Record<WikiPageType, string> = {
  project: "Projects",
  decision_log: "Decision Logs",
  pitfall_guide: "Pitfall Guides",
  runbook: "Runbooks",
  reference: "References",
  topic: "Topics"
};

const renderYamlString = (value: string | null): string =>
  value === null ? "null" : JSON.stringify(value);

const renderYamlArray = (values: string[]): string =>
  `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;

export const getPageOutputPath = (page: WikiPage): string =>
  `${PAGE_TYPE_DIRECTORIES[page.page_type]}/${page.slug}.md`;

export const buildFrontMatter = (page: WikiPage): string =>
  [
    "---",
    `page_id: ${renderYamlString(page.id)}`,
    `title: ${renderYamlString(page.title)}`,
    `page_type: ${renderYamlString(page.page_type)}`,
    `project: ${renderYamlString(page.project)}`,
    `status: ${renderYamlString(page.status)}`,
    `tags: ${renderYamlArray(page.tags)}`,
    `updated_at: ${renderYamlString(page.updated_at)}`,
    `source_memories: ${renderYamlArray(page.source_memory_ids)}`,
    "---"
  ].join("\n");

export const buildPublishedDocument = (page: WikiPage, content = page.content): string =>
  `${buildFrontMatter(page)}\n\n${content.trimEnd()}\n`;

const normalizeRelativePath = (value: string): string => {
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
};

export const replaceWikiLinksWithMarkdown = (
  content: string,
  currentPage: WikiPage,
  pagesBySlug: Map<string, WikiPage>
): string =>
  content.replace(
    /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g,
    (_match: string, rawSlug: string, rawAlias?: string) => {
      const slug = rawSlug.trim();
      const alias = rawAlias?.trim();
      const targetPage = pagesBySlug.get(slug);
      const label = alias && alias.length > 0 ? alias : targetPage?.title ?? slug;

      if (!targetPage) {
        return `[${label}](./${slug}.md)`;
      }

      const href = normalizeRelativePath(
        relative(dirname(getPageOutputPath(currentPage)), getPageOutputPath(targetPage))
      );

      return `[${label}](${href})`;
    }
  );

export const buildIndexDocument = (
  pages: WikiPage[],
  linkForPage: (page: WikiPage) => string,
  title = "Wiki Index"
): string => {
  const lines: string[] = [`# ${title}`, ""];

  for (const pageType of WIKI_PAGE_TYPES) {
    const group = pages
      .filter((page) => page.page_type === pageType)
      .sort((left, right) => left.title.localeCompare(right.title));

    if (group.length === 0) {
      continue;
    }

    lines.push(`## ${PAGE_TYPE_TITLES[pageType]}`, "");

    for (const page of group) {
      lines.push(`- ${linkForPage(page)}`);
    }

    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
};
