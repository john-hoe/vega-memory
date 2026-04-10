import { PageManager } from "../wiki/page-manager.js";
import type { WikiPage } from "../wiki/types.js";

interface NotionDatabaseResponse {
  properties?: Record<string, { type?: string }>;
}

interface NotionPageResponse {
  id: string;
}

interface NotionBlockListResponse {
  results?: Array<{ id?: string }>;
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface NotionPublishConfig {
  apiKey: string;
  databaseId: string;
}

type NotionPropertyType = "multi_select" | "rich_text" | "select" | "status" | "title";

type NotionPropertyDefinition = {
  type: NotionPropertyType;
};

type NotionRichText = {
  type: "text";
  text: {
    content: string;
  };
};

type NotionBlock = {
  object: "block";
  type: "bulleted_list_item" | "code" | "heading_1" | "heading_2" | "paragraph";
} & Record<string, unknown>;

const NOTION_API_BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const NOTION_PAGE_ID_PREFIX = "notion_page_id:";
const MAX_BLOCK_BATCH_SIZE = 100;
const MAX_RICH_TEXT_LENGTH = 2000;

const timestamp = (): string => new Date().toISOString();
const encodeNotionPathSegment = (value: string): string => encodeURIComponent(value);

const chunkRichText = (value: string): NotionRichText[] => {
  if (value.length === 0) {
    return [];
  }

  const chunks: NotionRichText[] = [];

  for (let index = 0; index < value.length; index += MAX_RICH_TEXT_LENGTH) {
    chunks.push({
      type: "text",
      text: {
        content: value.slice(index, index + MAX_RICH_TEXT_LENGTH)
      }
    });
  }

  return chunks;
};

const buildHeadingBlock = (
  type: "heading_1" | "heading_2",
  content: string
): NotionBlock => ({
  object: "block",
  type,
  [type]: {
    rich_text: chunkRichText(content)
  }
});

const buildParagraphBlock = (content: string): NotionBlock => ({
  object: "block",
  type: "paragraph",
  paragraph: {
    rich_text: chunkRichText(content)
  }
});

const buildBulletBlock = (content: string): NotionBlock => ({
  object: "block",
  type: "bulleted_list_item",
  bulleted_list_item: {
    rich_text: chunkRichText(content)
  }
});

const buildCodeBlock = (content: string): NotionBlock => ({
  object: "block",
  type: "code",
  code: {
    language: "plain text",
    rich_text: chunkRichText(content)
  }
});

export const MISSING_NOTION_PUBLISH_CONFIG_MESSAGE =
  "Notion publishing requires VEGA_NOTION_API_KEY and VEGA_NOTION_DB_ID environment variables.";

export class NotionPublisher {
  private databasePropertiesPromise: Promise<Record<string, NotionPropertyDefinition>> | null = null;

  constructor(
    private readonly pageManager: PageManager,
    private readonly config: NotionPublishConfig
  ) {
    if (
      this.config.apiKey.trim().length === 0 ||
      this.config.databaseId.trim().length === 0
    ) {
      throw new Error(MISSING_NOTION_PUBLISH_CONFIG_MESSAGE);
    }
  }

  async publishPage(page: WikiPage): Promise<{ notionPageId: string }> {
    const metadataKey = `${NOTION_PAGE_ID_PREFIX}${page.id}`;
    const existingPageId = this.pageManager.repository.getMetadata(metadataKey);
    const properties = await this.buildProperties(page);
    const blocks = this.markdownToNotionBlocks(page.content);
    const notionPageId =
      existingPageId === null
        ? await this.createNotionPage(properties, blocks)
        : await this.updateNotionPage(existingPageId, properties, blocks);

    this.pageManager.repository.setMetadata(metadataKey, notionPageId);
    this.pageManager.updatePage(
      page.id,
      { published_at: timestamp() },
      "Published wiki page to Notion"
    );

    return { notionPageId };
  }

  async publishAll(filters?: { project?: string }): Promise<{ published: number; errors: string[] }> {
    const pages = this.pageManager.listPages({
      project: filters?.project,
      status: "published",
      limit: Number.MAX_SAFE_INTEGER
    });
    const errors: string[] = [];
    let published = 0;

    for (const page of pages) {
      try {
        await this.publishPage(page);
        published += 1;
      } catch (error) {
        errors.push(
          `${page.slug}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return { published, errors };
  }

  private async getDatabaseProperties(): Promise<Record<string, NotionPropertyDefinition>> {
    if (this.databasePropertiesPromise === null) {
      this.databasePropertiesPromise = this.request<NotionDatabaseResponse>(
        `/databases/${encodeNotionPathSegment(this.config.databaseId)}`,
        { method: "GET" }
      )
        .then((response) => {
          const propertyEntries = Object.entries(response.properties ?? {});
          const properties = Object.fromEntries(
            propertyEntries
              .map(([name, definition]) => {
                const type = definition.type;

                if (
                  type !== "title" &&
                  type !== "rich_text" &&
                  type !== "select" &&
                  type !== "status" &&
                  type !== "multi_select"
                ) {
                  return null;
                }

                return [name, { type }] as const;
              })
              .filter((entry): entry is [string, NotionPropertyDefinition] => entry !== null)
          );

          return properties;
        })
        .catch((error: unknown) => {
          this.databasePropertiesPromise = null;
          throw error;
        });
    }

    return this.databasePropertiesPromise;
  }

  private async buildProperties(page: WikiPage): Promise<Record<string, unknown>> {
    const databaseProperties = await this.getDatabaseProperties();
    const titleProperty = databaseProperties.Title;

    if (titleProperty?.type !== "title") {
      throw new Error("Notion database must include a Title title property.");
    }

    const properties: Record<string, unknown> = {
      Title: {
        title: chunkRichText(page.title)
      }
    };

    const maybeAssign = (
      name: "Project" | "Status" | "Tags" | "Type",
      value: string | string[] | null
    ): void => {
      const property = databaseProperties[name];

      if (!property) {
        return;
      }

      properties[name] = this.mapPropertyValue(property.type, value);
    };

    maybeAssign("Type", page.page_type);
    maybeAssign("Project", page.project);
    maybeAssign("Status", page.status);
    maybeAssign("Tags", page.tags);

    return properties;
  }

  private mapPropertyValue(
    type: NotionPropertyType,
    value: string | string[] | null
  ): Record<string, unknown> {
    if (type === "multi_select") {
      const values = Array.isArray(value) ? value : value === null ? [] : [value];

      return {
        multi_select: values.map((entry) => ({
          name: entry
        }))
      };
    }

    if (type === "status") {
      return {
        status: value === null ? null : { name: String(value) }
      };
    }

    if (type === "select") {
      return {
        select: value === null ? null : { name: String(value) }
      };
    }

    if (type === "title") {
      return {
        title: chunkRichText(Array.isArray(value) ? value.join(", ") : value ?? "")
      };
    }

    return {
      rich_text: chunkRichText(Array.isArray(value) ? value.join(", ") : value ?? "")
    };
  }

  private async createNotionPage(
    properties: Record<string, unknown>,
    contentBlocks: NotionBlock[]
  ): Promise<string> {
    const initialChildren = contentBlocks.slice(0, MAX_BLOCK_BATCH_SIZE);
    const response = await this.request<NotionPageResponse>("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: {
          database_id: this.config.databaseId
        },
        properties,
        ...(initialChildren.length > 0 ? { children: initialChildren } : {})
      })
    });

    await this.appendBlockChildren(response.id, contentBlocks.slice(MAX_BLOCK_BATCH_SIZE));

    return response.id;
  }

  private async updateNotionPage(
    pageId: string,
    properties: Record<string, unknown>,
    contentBlocks: NotionBlock[]
  ): Promise<string> {
    await this.request(`/pages/${encodeNotionPathSegment(pageId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties
      })
    });

    const childIds = await this.listBlockChildren(pageId);
    await this.appendBlockChildren(pageId, contentBlocks);

    for (const childId of childIds) {
      try {
        await this.request(`/blocks/${encodeNotionPathSegment(childId)}`, {
          method: "DELETE"
        });
      } catch {
        // Best-effort cleanup after the replacement content is already safe.
      }
    }

    return pageId;
  }

  private async appendBlockChildren(pageId: string, contentBlocks: NotionBlock[]): Promise<void> {
    for (let index = 0; index < contentBlocks.length; index += MAX_BLOCK_BATCH_SIZE) {
      const chunk = contentBlocks.slice(index, index + MAX_BLOCK_BATCH_SIZE);

      await this.request(`/blocks/${encodeNotionPathSegment(pageId)}/children`, {
        method: "PATCH",
        body: JSON.stringify({
          children: chunk
        })
      });
    }
  }

  private async listBlockChildren(pageId: string): Promise<string[]> {
    const blockIds: string[] = [];
    let nextCursor: string | null | undefined = undefined;

    do {
      const search = new URLSearchParams({
        page_size: String(MAX_BLOCK_BATCH_SIZE)
      });

      if (nextCursor) {
        search.set("start_cursor", nextCursor);
      }

      const response = await this.request<NotionBlockListResponse>(
        `/blocks/${encodeNotionPathSegment(pageId)}/children?${search.toString()}`,
        { method: "GET" }
      );

      for (const block of response.results ?? []) {
        if (typeof block.id === "string" && block.id.length > 0) {
          blockIds.push(block.id);
        }
      }

      nextCursor = response.has_more ? response.next_cursor : null;
    } while (nextCursor);

    return blockIds;
  }

  private async request<T = undefined>(
    path: string,
    init: RequestInit
  ): Promise<T> {
    const response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Notion API request failed with status ${response.status}${detail ? `: ${detail}` : ""}`
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  markdownToNotionBlocks(content: string): NotionBlock[] {
    const blocks: NotionBlock[] = [];
    const paragraphLines: string[] = [];
    const codeLines: string[] = [];
    let inCodeBlock = false;

    const flushParagraph = (): void => {
      if (paragraphLines.length === 0) {
        return;
      }

      blocks.push(buildParagraphBlock(paragraphLines.join(" ")));
      paragraphLines.length = 0;
    };

    const flushCodeBlock = (): void => {
      if (codeLines.length === 0) {
        return;
      }

      blocks.push(buildCodeBlock(codeLines.join("\n")));
      codeLines.length = 0;
    };

    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();

      if (line.startsWith("```")) {
        flushParagraph();

        if (inCodeBlock) {
          flushCodeBlock();
        }

        inCodeBlock = !inCodeBlock;
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(rawLine);
        continue;
      }

      if (line.length === 0) {
        flushParagraph();
        continue;
      }

      if (line.startsWith("# ")) {
        flushParagraph();
        blocks.push(buildHeadingBlock("heading_1", line.slice(2).trim()));
        continue;
      }

      if (line.startsWith("## ")) {
        flushParagraph();
        blocks.push(buildHeadingBlock("heading_2", line.slice(3).trim()));
        continue;
      }

      if (line.startsWith("- ")) {
        flushParagraph();
        blocks.push(buildBulletBlock(line.slice(2).trim()));
        continue;
      }

      if (/^`[^`]+`$/u.test(line)) {
        flushParagraph();
        blocks.push(buildCodeBlock(line.slice(1, -1)));
        continue;
      }

      paragraphLines.push(line);
    }

    flushParagraph();
    flushCodeBlock();

    return blocks.length > 0 ? blocks : [buildParagraphBlock("")];
  }
}
