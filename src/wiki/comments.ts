import { v4 as uuidv4 } from "uuid";

import { Repository } from "../db/repository.js";
import { PageManager } from "./page-manager.js";
import { NotificationService } from "./notifications.js";

export interface WikiComment {
  id: string;
  page_id: string;
  user_id: string;
  content: string;
  mentions: string[];
  parent_comment_id?: string;
  created_at: string;
  updated_at?: string;
}

const MENTION_PATTERN = /@[\w.-]+/gu;

const now = (): string => new Date().toISOString();

const normalizeIdentifier = (value: string, field: string): string => {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new Error(`${field} is required`);
  }

  return normalized;
};

const normalizeContent = (value: string): string => {
  if (value.trim().length === 0) {
    throw new Error("content is required");
  }

  return value;
};

const normalizeMentionKey = (value: string): string => value.trim().toLowerCase();

const resolveMentionKeysForUser = (user: {
  email: string;
  name: string;
}): string[] => {
  const keys = [normalizeMentionKey(user.name)];
  const emailLocalPart = user.email.split("@")[0]?.trim().toLowerCase();

  if (emailLocalPart) {
    keys.push(emailLocalPart);
  }

  return keys.filter((key, index) => key.length > 0 && keys.indexOf(key) === index);
};

export class CommentService {
  private readonly notificationService: NotificationService;

  private readonly pageManager: PageManager;

  constructor(private readonly repository: Repository) {
    this.notificationService = new NotificationService(repository);
    this.pageManager = new PageManager(repository);
  }

  addComment(
    pageId: string,
    userId: string,
    content: string,
    parentCommentId?: string
  ): WikiComment {
    const normalizedPageId = normalizeIdentifier(pageId, "page_id");
    const normalizedUserId = normalizeIdentifier(userId, "user_id");
    const normalizedParentCommentId =
      parentCommentId === undefined ? undefined : normalizeIdentifier(parentCommentId, "parent_comment_id");
    const page = this.pageManager.getPage(normalizedPageId);

    if (!page) {
      throw new Error(`Wiki page not found: ${normalizedPageId}`);
    }

    const parentComment =
      normalizedParentCommentId === undefined
        ? null
        : this.repository.getWikiComment(normalizedParentCommentId);

    if (normalizedParentCommentId !== undefined && parentComment === null) {
      throw new Error(`Wiki comment not found: ${normalizedParentCommentId}`);
    }

    if (parentComment !== null && parentComment.page_id !== normalizedPageId) {
      throw new Error("Parent comment must belong to the same wiki page");
    }

    const comment: WikiComment = {
      id: uuidv4(),
      page_id: normalizedPageId,
      user_id: normalizedUserId,
      content: normalizeContent(content),
      mentions: this.extractMentions(content),
      ...(normalizedParentCommentId === undefined
        ? {}
        : { parent_comment_id: normalizedParentCommentId }),
      created_at: now()
    };

    this.repository.createWikiComment(comment);
    this.createMentionNotifications(comment, page.title, []);

    if (parentComment !== null && parentComment.user_id !== normalizedUserId) {
      this.notificationService.createNotification(
        parentComment.user_id,
        "reply",
        comment.id,
        `New reply on wiki page "${page.title}"`
      );
    }

    return comment;
  }

  getComments(
    pageId: string,
    options?: {
      limit?: number;
      sort?: string;
    }
  ): WikiComment[] {
    return this.repository.listWikiComments(normalizeIdentifier(pageId, "page_id"), options);
  }

  updateComment(commentId: string, userId: string, newContent: string): WikiComment {
    const normalizedCommentId = normalizeIdentifier(commentId, "comment_id");
    const normalizedUserId = normalizeIdentifier(userId, "user_id");
    const existing = this.repository.getWikiComment(normalizedCommentId);

    if (!existing) {
      throw new Error(`Wiki comment not found: ${normalizedCommentId}`);
    }

    if (existing.user_id !== normalizedUserId) {
      throw new Error("Only the author can update this comment");
    }

    const updatedAt = now();
    const updatedMentions = this.extractMentions(newContent);

    this.repository.updateWikiComment(normalizedCommentId, {
      content: normalizeContent(newContent),
      mentions: updatedMentions,
      updated_at: updatedAt
    });

    const updatedComment: WikiComment = {
      ...existing,
      content: newContent,
      mentions: updatedMentions,
      updated_at: updatedAt
    };
    const page = this.pageManager.getPage(existing.page_id);

    if (page) {
      this.createMentionNotifications(updatedComment, page.title, existing.mentions);
    }

    return updatedComment;
  }

  deleteComment(commentId: string, userId: string): void {
    const normalizedCommentId = normalizeIdentifier(commentId, "comment_id");
    const normalizedUserId = normalizeIdentifier(userId, "user_id");
    const comment = this.repository.getWikiComment(normalizedCommentId);

    if (!comment) {
      throw new Error(`Wiki comment not found: ${normalizedCommentId}`);
    }

    const actor = this.repository.getUser(normalizedUserId);
    const isAdmin = actor?.role === "admin";

    if (comment.user_id !== normalizedUserId && !isAdmin) {
      throw new Error("Only the author or an admin can delete this comment");
    }

    this.repository.deleteWikiComment(normalizedCommentId);
  }

  getThread(parentCommentId: string): WikiComment[] {
    return this.repository.listWikiCommentThread(
      normalizeIdentifier(parentCommentId, "parent_comment_id")
    );
  }

  extractMentions(content: string): string[] {
    return [...new Set((content.match(MENTION_PATTERN) ?? []).map((match) => match.slice(1)))];
  }

  private createMentionNotifications(
    comment: WikiComment,
    pageTitle: string,
    previousMentions: string[]
  ): void {
    const previousMentionKeys = new Set(previousMentions.map(normalizeMentionKey));
    const targetUsers = this.resolveMentionedUsers(comment.page_id, comment.mentions);

    for (const user of targetUsers) {
      const keys = resolveMentionKeysForUser(user);
      const isNewMention = keys.some((key) => !previousMentionKeys.has(key));

      if (!isNewMention || user.id === comment.user_id) {
        continue;
      }

      this.notificationService.createNotification(
        user.id,
        "mention",
        comment.id,
        `You were mentioned in a comment on wiki page "${pageTitle}"`
      );
    }
  }

  private resolveMentionedUsers(pageId: string, mentions: string[]): Array<{
    id: string;
    email: string;
    name: string;
  }> {
    if (mentions.length === 0) {
      return [];
    }

    const mentionKeys = new Set(mentions.map(normalizeMentionKey));
    const tenantId = this.repository.getWikiPageTenantId(pageId) ?? undefined;
    const users = this.repository.listUsers(tenantId);

    return users.filter((user) =>
      resolveMentionKeysForUser(user).some((key) => mentionKeys.has(key))
    );
  }
}

export { CommentService as WikiCommentService };
