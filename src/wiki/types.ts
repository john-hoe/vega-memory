export type WikiPageType =
  | "topic"
  | "project"
  | "decision_log"
  | "pitfall_guide"
  | "runbook"
  | "reference";

export type WikiPageStatus = "draft" | "published" | "stale" | "archived";

export const WIKI_PAGE_TYPES = [
  "topic",
  "project",
  "decision_log",
  "pitfall_guide",
  "runbook",
  "reference"
] as const satisfies readonly WikiPageType[];

export const WIKI_PAGE_STATUSES = [
  "draft",
  "published",
  "stale",
  "archived"
] as const satisfies readonly WikiPageStatus[];

export type ContentSourceType =
  | "web_article"
  | "wechat"
  | "twitter"
  | "rss"
  | "manual_note"
  | "file";

export interface WikiPage {
  id: string;
  slug: string;
  title: string;
  content: string;
  summary: string;
  page_type: WikiPageType;
  scope: "project" | "global";
  project: string | null;
  tags: string[];
  source_memory_ids: string[];
  embedding: Buffer | null;
  status: WikiPageStatus;
  auto_generated: boolean;
  reviewed: boolean;
  version: number;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  published_at: string | null;
}

export interface WikiPageVersion {
  id: string;
  page_id: string;
  content: string;
  summary: string;
  version: number;
  change_reason: string;
  created_at: string;
}

export interface WikiCrossReference {
  id: string;
  source_page_id: string;
  target_page_id: string;
  context: string;
  auto_generated: boolean;
  created_at: string;
}

export interface ContentSource {
  id: string;
  source_type: ContentSourceType;
  url: string | null;
  title: string;
  raw_content: string;
  extracted_at: string;
  processed: boolean;
  project: string | null;
  tags: string[];
}

export interface WikiPageListFilters {
  project?: string;
  page_type?: WikiPageType;
  status?: WikiPageStatus;
  parent_id?: string | null;
  limit?: number;
  sort?: string;
}

export interface PageWithBacklinks {
  page: WikiPage;
  backlinks: { page_id: string; title: string; slug: string; context: string }[];
}
