import { CrossReferenceService } from "./cross-reference.js";
import { PageManager } from "./page-manager.js";
import type { WikiPageStatus } from "./types.js";

export type WikiReviewAction = "approve" | "reject" | "edit";

export interface WikiReviewResult {
  page_id: string;
  new_status: WikiPageStatus;
}

export const WIKI_REVIEW_ACTIONS = [
  "approve",
  "reject",
  "edit"
] as const satisfies readonly WikiReviewAction[];

export function reviewWikiPage(
  pageManager: PageManager,
  crossReferenceService: CrossReferenceService,
  idOrSlug: string,
  action: WikiReviewAction,
  content?: string
): WikiReviewResult {
  const page = pageManager.getPage(idOrSlug);

  if (!page) {
    throw new Error(`Wiki page not found: ${idOrSlug}`);
  }

  const reviewedAt = new Date().toISOString();

  if (action === "approve") {
    const updatedPage = pageManager.updatePage(
      page.id,
      {
        status: "published",
        reviewed: true,
        reviewed_at: reviewedAt,
        published_at: page.published_at ?? reviewedAt
      },
      "Approved wiki page"
    );

    crossReferenceService.updateCrossReferences(updatedPage);

    return {
      page_id: updatedPage.id,
      new_status: updatedPage.status
    };
  }

  if (action === "reject") {
    const updatedPage = pageManager.updatePage(
      page.id,
      {
        status: "archived"
      },
      "Rejected wiki page"
    );

    return {
      page_id: updatedPage.id,
      new_status: updatedPage.status
    };
  }

  if (content === undefined || content.trim().length === 0) {
    throw new Error("content is required when action is edit");
  }

  const updatedPage = pageManager.updatePage(
    page.id,
    {
      content,
      status: "published",
      reviewed: true,
      reviewed_at: reviewedAt,
      published_at: page.published_at ?? reviewedAt
    },
    "Edited wiki page"
  );

  crossReferenceService.updateCrossReferences(updatedPage);

  return {
    page_id: updatedPage.id,
    new_status: updatedPage.status
  };
}
