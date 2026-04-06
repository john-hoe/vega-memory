import { v4 as uuidv4 } from "uuid";

import type { VegaConfig } from "../config.js";
import type { StoreParams, StoreResult } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { PageManager } from "../wiki/page-manager.js";
import { ContentFetcher } from "./fetcher.js";
import { ContentDistiller } from "./distiller.js";

export interface RSSFeed {
  id: string;
  url: string;
  title: string;
  project: string | null;
  last_polled_at: string | null;
  last_entry_at: string | null;
  active: boolean;
  created_at: string;
}

interface RSSFeedRow {
  id: string;
  url: string;
  title: string;
  project: string | null;
  last_polled_at: string | null;
  last_entry_at: string | null;
  active: number;
  created_at: string;
}

interface FeedEntry {
  title: string;
  link: string | null;
  published_at: string | null;
}

type MemoryStoreService = {
  store(params: StoreParams): Promise<StoreResult>;
};

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "vega-memory/0.1 rss";

const decodeEntities = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");

const stripTags = (value: string): string => value.replace(/<[^>]+>/g, " ");

const now = (): string => new Date().toISOString();

const fetchWithTimeout = async (input: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
};

const mapFeed = (row: RSSFeedRow): RSSFeed => ({
  ...row,
  active: row.active === 1
});

const extractText = (value: string, pattern: RegExp): string | null => {
  const match = pattern.exec(value);
  return match?.[1] ? decodeEntities(stripTags(match[1])).replace(/\s+/g, " ").trim() : null;
};

const parseDate = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

const parseFeedTitle = (xml: string): string => {
  const channel = /<channel\b[^>]*>([\s\S]*?)<\/channel>/i.exec(xml)?.[1];
  const feed = /<feed\b[^>]*>([\s\S]*?)<\/feed>/i.exec(xml)?.[1];
  const title =
    (channel ? extractText(channel, /<title\b[^>]*>([\s\S]*?)<\/title>/i) : null) ??
    (feed ? extractText(feed, /<title\b[^>]*>([\s\S]*?)<\/title>/i) : null);

  return title && title.length > 0 ? title : "Untitled Feed";
};

const extractLink = (block: string): string | null => {
  const textLink = extractText(block, /<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (textLink) {
    return textLink;
  }

  const hrefMatch = /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  return hrefMatch?.[1]?.trim() ?? null;
};

const parseEntries = (xml: string): FeedEntry[] => {
  const blocks = [
    ...(xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? []),
    ...(xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) ?? [])
  ];

  return blocks
    .map((block) => ({
      title: extractText(block, /<title\b[^>]*>([\s\S]*?)<\/title>/i) ?? "Untitled Entry",
      link: extractLink(block),
      published_at: parseDate(
        extractText(block, /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i) ??
          extractText(block, /<published\b[^>]*>([\s\S]*?)<\/published>/i) ??
          extractText(block, /<updated\b[^>]*>([\s\S]*?)<\/updated>/i)
      )
    }))
    .sort((left, right) => {
      const leftTime = left.published_at ? Date.parse(left.published_at) : 0;
      const rightTime = right.published_at ? Date.parse(right.published_at) : 0;
      return rightTime - leftTime;
    });
};

export class RSSService {
  constructor(private readonly repository: Repository) {}

  private async fetchFeedXml(url: string): Promise<string> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
    }

    const response = await fetchWithTimeout(
      parsedUrl.toString(),
      {
        headers: {
          "user-agent": USER_AGENT
        }
      },
      FETCH_TIMEOUT_MS
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Failed to fetch feed ${parsedUrl.toString()} with status ${response.status}${detail ? `: ${detail}` : ""}`
      );
    }

    return await response.text();
  }

  private contentSourceExists(url: string): boolean {
    const row = this.repository.db
      .prepare<[string], { id: string }>("SELECT id FROM content_sources WHERE url = ? LIMIT 1")
      .get(url);

    return row !== undefined;
  }

  addFeed = async (url: string, project?: string): Promise<{ id: string; title: string }> => {
    const xml = await this.fetchFeedXml(url);
    const id = uuidv4();
    const title = parseFeedTitle(xml);
    const createdAt = now();

    this.repository.db
      .prepare<[string, string, string, string | null, string]>(
        `INSERT INTO rss_feeds (
           id, url, title, project, created_at
         )
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, url, title, project ?? null, createdAt);

    return { id, title };
  };

  removeFeed(id: string): void {
    this.repository.db
      .prepare<[string]>("UPDATE rss_feeds SET active = 0 WHERE id = ?")
      .run(id);
  }

  listFeeds(): RSSFeed[] {
    return this.repository.db
      .prepare<[], RSSFeedRow>(
        `SELECT *
         FROM rss_feeds
         WHERE active = 1
         ORDER BY created_at DESC`
      )
      .all()
      .map(mapFeed);
  }

  async pollFeed(
    feed: RSSFeed,
    fetcher: ContentFetcher,
    distiller: ContentDistiller,
    pageManager: PageManager,
    memoryService: MemoryStoreService,
    config: VegaConfig
  ): Promise<number> {
    const xml = await this.fetchFeedXml(feed.url);
    const entries = parseEntries(xml);
    const lastEntryTime = feed.last_entry_at ? Date.parse(feed.last_entry_at) : null;
    const pendingEntries = entries
      .filter((entry) => entry.link !== null)
      .filter((entry) => !this.contentSourceExists(entry.link as string))
      .filter((entry) => {
        if (lastEntryTime === null) {
          return true;
        }

        if (entry.published_at === null) {
          return false;
        }

        return Date.parse(entry.published_at) > lastEntryTime;
      })
      .sort((left, right) => {
        const leftTime = left.published_at ? Date.parse(left.published_at) : 0;
        const rightTime = right.published_at ? Date.parse(right.published_at) : 0;
        return leftTime - rightTime;
      });

    let processed = 0;
    const newestEntryAt =
      pendingEntries[0] === undefined
        ? feed.last_entry_at
        : pendingEntries.reduce<string | null>(
            (latest, entry) => {
              if (!entry.published_at) {
                return latest ?? now();
              }

              if (latest === null || Date.parse(entry.published_at) > Date.parse(latest)) {
                return entry.published_at;
              }

              return latest;
            },
            feed.last_entry_at
          );

    for (const entry of pendingEntries) {
      const extracted = await fetcher.fetchUrl(entry.link as string);
      const source = pageManager.createContentSource({
        source_type: "rss",
        url: entry.link,
        title: extracted.title || entry.title,
        raw_content: extracted.content,
        project: feed.project,
        tags: ["rss"]
      });
      const memories = await distiller.distill(
        extracted.content,
        extracted.title || entry.title,
        feed.project ?? undefined
      );

      await distiller.storeDistilled(memories, feed.project ?? "global", memoryService, config);
      pageManager.markContentSourceProcessed(source.id);
      processed += 1;
    }

    this.repository.db
      .prepare<[string, string | null, string]>(
        `UPDATE rss_feeds
         SET last_polled_at = ?, last_entry_at = ?
         WHERE id = ?`
      )
      .run(now(), newestEntryAt, feed.id);

    return processed;
  }
}
