import { Repository } from "../db/repository.js";
import { PageManager } from "./page-manager.js";
import type { WikiPage, WikiPageStatus, WikiPageType } from "./types.js";

interface WikiPageRow {
  id: string;
  slug: string;
  title: string;
  content: string;
  summary: string;
  page_type: WikiPageType;
  scope: WikiPage["scope"];
  project: string | null;
  tags: string;
  source_memory_ids: string;
  embedding: Buffer | null;
  status: WikiPageStatus;
  auto_generated: number;
  reviewed: number;
  version: number;
  space_id: string | null;
  parent_id: string | null;
  tenant_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  published_at: string | null;
}

interface CountRow {
  total: number;
}

interface TextRange {
  start: number;
  end: number;
}

interface WikiLinkMatch {
  slug: string;
  start: number;
  end: number;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

type PageManagerWithRepository = PageManager & {
  repository: Repository;
};

const WIKI_LINK_PATTERN = /\[\[([a-z0-9-]+)\]\]/g;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
}

function mapWikiPage(row: WikiPageRow): WikiPage {
  return {
    ...row,
    tags: parseJsonArray(row.tags),
    source_memory_ids: parseJsonArray(row.source_memory_ids),
    auto_generated: row.auto_generated === 1,
    reviewed: row.reviewed === 1
  };
}

function getRepository(pageManager: PageManager): Repository {
  return Reflect.get(pageManager as PageManagerWithRepository, "repository") as Repository;
}

function getTextRanges(content: string): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = 0;
  let rangeStart = 0;
  let mode: "text" | "inline" | "fenced" = "text";

  while (cursor < content.length) {
    if (mode === "text" && content.startsWith("```", cursor)) {
      if (rangeStart < cursor) {
        ranges.push({ start: rangeStart, end: cursor });
      }
      cursor += 3;
      rangeStart = cursor;
      mode = "fenced";
      continue;
    }

    if (mode === "fenced" && content.startsWith("```", cursor)) {
      cursor += 3;
      rangeStart = cursor;
      mode = "text";
      continue;
    }

    if (mode === "text" && content[cursor] === "`") {
      if (rangeStart < cursor) {
        ranges.push({ start: rangeStart, end: cursor });
      }
      cursor += 1;
      rangeStart = cursor;
      mode = "inline";
      continue;
    }

    if (mode === "inline" && content[cursor] === "`") {
      cursor += 1;
      rangeStart = cursor;
      mode = "text";
      continue;
    }

    cursor += 1;
  }

  if (mode === "text" && rangeStart < content.length) {
    ranges.push({ start: rangeStart, end: content.length });
  }

  return ranges;
}

function findWikiLinkMatches(content: string): WikiLinkMatch[] {
  const matches: WikiLinkMatch[] = [];

  for (const range of getTextRanges(content)) {
    const text = content.slice(range.start, range.end);

    for (const match of text.matchAll(WIKI_LINK_PATTERN)) {
      const slug = match[1];
      const matchIndex = match.index;

      if (slug === undefined || matchIndex === undefined) {
        continue;
      }

      matches.push({
        slug,
        start: range.start + matchIndex,
        end: range.start + matchIndex + match[0].length
      });
    }
  }

  return matches;
}

function isWordBoundary(character: string | undefined): boolean {
  return character === undefined || !WORD_CHARACTER_PATTERN.test(character);
}

function isExactTitleMatch(content: string, start: number, end: number): boolean {
  return isWordBoundary(content[start - 1]) && isWordBoundary(content[end]);
}

function overlapsRange(start: number, end: number, ranges: Array<Pick<Replacement, "start" | "end">>): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHeadingLine(content: string, start: number, end: number): boolean {
  const lineStart = content.lastIndexOf("\n", start - 1) + 1;
  const nextNewline = content.indexOf("\n", end);
  const lineEnd = nextNewline === -1 ? content.length : nextNewline;
  const line = content.slice(lineStart, lineEnd).trim();
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);

  if (!heading) {
    return false;
  }

  return heading[2].trim().toLowerCase() === content.slice(start, end).trim().toLowerCase();
}

function truncateContext(content: string, start: number, end: number, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  const matchCenter = Math.floor((start + end) / 2);
  let snippetStart = Math.max(0, matchCenter - Math.floor(maxLength / 2));
  let snippetEnd = snippetStart + maxLength;

  if (snippetEnd > content.length) {
    snippetEnd = content.length;
    snippetStart = Math.max(0, snippetEnd - maxLength);
  }

  return content.slice(snippetStart, snippetEnd).trim();
}

function extractContext(content: string, start: number, end: number): string {
  const leadingText = content.slice(0, start);
  const trailingText = content.slice(end);
  const sentenceStart = Math.max(
    leadingText.lastIndexOf("."),
    leadingText.lastIndexOf("!"),
    leadingText.lastIndexOf("?"),
    leadingText.lastIndexOf("\n")
  );
  const trailingBoundaryCandidates = [
    trailingText.indexOf("."),
    trailingText.indexOf("!"),
    trailingText.indexOf("?"),
    trailingText.indexOf("\n")
  ].filter((index) => index >= 0);
  const sentenceEndOffset =
    trailingBoundaryCandidates.length > 0 ? Math.min(...trailingBoundaryCandidates) : trailingText.length;
  const sentence = content.slice(sentenceStart + 1, end + sentenceEndOffset).trim();

  return truncateContext(sentence, start - (sentenceStart + 1), end - (sentenceStart + 1), 100);
}

function injectSegment(segment: string, pages: WikiPage[]): string {
  const replacements: Replacement[] = [];
  const existingLinkRanges = Array.from(segment.matchAll(WIKI_LINK_PATTERN), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }));

  for (const page of pages) {
    if (page.title.trim().length === 0) {
      continue;
    }

    const titlePattern = new RegExp(escapeRegex(page.title), "gi");

    for (const match of segment.matchAll(titlePattern)) {
      const matchIndex = match.index;

      if (matchIndex === undefined) {
        continue;
      }

      const start = matchIndex;
      const end = start + match[0].length;

      if (!isExactTitleMatch(segment, start, end)) {
        continue;
      }

      if (isHeadingLine(segment, start, end)) {
        continue;
      }

      if (overlapsRange(start, end, existingLinkRanges) || overlapsRange(start, end, replacements)) {
        continue;
      }

      replacements.push({
        start,
        end,
        value: `[[${page.slug}]]`
      });
    }
  }

  if (replacements.length === 0) {
    return segment;
  }

  replacements.sort((left, right) => left.start - right.start);
  let cursor = 0;
  let result = "";

  for (const replacement of replacements) {
    result += segment.slice(cursor, replacement.start);
    result += replacement.value;
    cursor = replacement.end;
  }

  result += segment.slice(cursor);
  return result;
}

export class CrossReferenceService {
  constructor(private readonly pageManager: PageManager) {}

  extractWikiLinks(content: string): string[] {
    return Array.from(new Set(findWikiLinkMatches(content).map((match) => match.slug)));
  }

  updateCrossReferences(page: WikiPage): { added: number; removed: number } {
    const repository = getRepository(this.pageManager);
    const matches = findWikiLinkMatches(page.content);
    const uniqueMatches = new Map<string, WikiLinkMatch>();

    for (const match of matches) {
      if (!uniqueMatches.has(match.slug)) {
        uniqueMatches.set(match.slug, match);
      }
    }

    const removed =
      repository.db
        .prepare<[string], CountRow>(
          "SELECT COUNT(*) AS total FROM wiki_cross_references WHERE source_page_id = ?"
        )
        .get(page.id)?.total ?? 0;

    let added = 0;

    repository.db.transaction(() => {
      this.pageManager.removeCrossReferences(page.id);

      for (const [slug, match] of uniqueMatches) {
        const targetPage = this.pageManager.getPage(slug);

        if (!targetPage || targetPage.id === page.id) {
          continue;
        }

        this.pageManager.addCrossReference(
          page.id,
          targetPage.id,
          extractContext(page.content, match.start, match.end),
          true
        );
        added += 1;
      }
    });

    return { added, removed };
  }

  injectWikiLinks(content: string, existingPages: WikiPage[]): string {
    const uniquePagesByTitle = new Map<string, WikiPage[]>();

    for (const page of existingPages) {
      const titleKey = page.title.trim().toLowerCase();

      if (titleKey.length === 0) {
        continue;
      }

      const pages = uniquePagesByTitle.get(titleKey) ?? [];
      pages.push(page);
      uniquePagesByTitle.set(titleKey, pages);
    }

    const candidates = Array.from(uniquePagesByTitle.values())
      .filter((pages) => pages.length === 1)
      .map(([page]) => page)
      .sort((left, right) => {
        const titleLengthDelta = right.title.length - left.title.length;
        return titleLengthDelta !== 0 ? titleLengthDelta : left.slug.localeCompare(right.slug);
      });

    if (candidates.length === 0) {
      return content;
    }

    let result = "";
    let cursor = 0;

    for (const range of getTextRanges(content)) {
      result += content.slice(cursor, range.start);
      result += injectSegment(content.slice(range.start, range.end), candidates);
      cursor = range.end;
    }

    result += content.slice(cursor);
    return result;
  }

  getBacklinks(pageId: string): { page_id: string; title: string; slug: string; context: string }[] {
    return this.pageManager.getBacklinks(pageId);
  }

  findOrphanPages(): WikiPage[] {
    const repository = getRepository(this.pageManager);

    return repository.db
      .prepare<[], WikiPageRow>(
        `SELECT wiki_pages.*
         FROM wiki_pages
         LEFT JOIN wiki_cross_references AS incoming
           ON incoming.target_page_id = wiki_pages.id
         LEFT JOIN wiki_cross_references AS outgoing
           ON outgoing.source_page_id = wiki_pages.id
         WHERE wiki_pages.status = 'published'
           AND incoming.id IS NULL
           AND outgoing.id IS NULL
         ORDER BY wiki_pages.updated_at DESC`
      )
      .all()
      .map(mapWikiPage);
  }
}
