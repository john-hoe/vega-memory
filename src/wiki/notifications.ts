import { v4 as uuidv4 } from "uuid";

import { Repository } from "../db/repository.js";

export interface WikiNotification {
  id: string;
  user_id: string;
  type: "mention" | "reply" | "page_update";
  source_id: string;
  message: string;
  read: boolean;
  created_at: string;
}

const now = (): string => new Date().toISOString();

const normalizeIdentifier = (value: string, field: string): string => {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new Error(`${field} is required`);
  }

  return normalized;
};

const normalizeMessage = (value: string): string => {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new Error("message is required");
  }

  return normalized;
};

export class NotificationService {
  constructor(private readonly repository: Repository) {}

  createNotification(
    userId: string,
    type: WikiNotification["type"],
    sourceId: string,
    message: string
  ): WikiNotification {
    const notification: WikiNotification = {
      id: uuidv4(),
      user_id: normalizeIdentifier(userId, "user_id"),
      type,
      source_id: normalizeIdentifier(sourceId, "source_id"),
      message: normalizeMessage(message),
      read: false,
      created_at: now()
    };

    this.repository.createWikiNotification(notification);
    return notification;
  }

  getUnread(userId: string): WikiNotification[] {
    return this.repository.listUnreadWikiNotifications(
      normalizeIdentifier(userId, "user_id")
    );
  }

  markRead(notificationId: string): void {
    this.repository.markWikiNotificationRead(
      normalizeIdentifier(notificationId, "notification_id")
    );
  }

  markAllRead(userId: string): void {
    this.repository.markAllWikiNotificationsRead(
      normalizeIdentifier(userId, "user_id")
    );
  }
}
