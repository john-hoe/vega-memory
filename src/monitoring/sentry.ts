import { randomUUID } from "node:crypto";

import * as Sentry from "@sentry/node";

interface SentryStubConfig {
  dsn?: string;
  environment?: string;
  enabled: boolean;
}

interface SentryUser {
  id: string;
  email?: string;
}

interface SentryEvent {
  id: string;
  type: string;
  data: unknown;
}

interface SentrySdkLike {
  init(config: Record<string, unknown>): void;
  captureException(error: Error, scope?: Record<string, unknown>): string;
  captureMessage(message: string, scope?: Record<string, unknown>): string;
  setUser(user: SentryUser): void;
  setTag(key: string, value: string): void;
}

export class SentryStub {
  private readonly events: SentryEvent[] = [];
  private user?: SentryUser;
  private readonly tags = new Map<string, string>();
  private initialized = false;

  constructor(
    private readonly config: SentryStubConfig,
    private readonly sdk: SentrySdkLike = Sentry as unknown as SentrySdkLike
  ) {}

  captureException(error: Error, context?: Record<string, unknown>): string {
    this.ensureInitialized();
    const id = this.sdk.captureException(error, { extra: context ?? {} });

    this.events.push({
      id,
      type: "exception",
      data: {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack
        },
        context: context ?? {},
        environment: this.config.environment,
        enabled: this.config.enabled,
        user: this.user,
        tags: Object.fromEntries(this.tags)
      }
    });

    return id;
  }

  captureMessage(message: string, level: "info" | "warning" | "error" = "info"): string {
    this.ensureInitialized();
    const id = this.sdk.captureMessage(message, { level });

    this.events.push({
      id,
      type: "message",
      data: {
        message,
        level,
        environment: this.config.environment,
        enabled: this.config.enabled,
        user: this.user,
        tags: Object.fromEntries(this.tags)
      }
    });

    return id;
  }

  setUser(user: SentryUser): void {
    this.user = { ...user };
    if (this.config.enabled && this.config.dsn) {
      this.sdk.setUser(this.user);
    }
  }

  setTag(key: string, value: string): void {
    this.tags.set(key, value);
    if (this.config.enabled && this.config.dsn) {
      this.sdk.setTag(key, value);
    }
  }

  getEvents(): Array<{ id: string; type: string; data: unknown }> {
    return this.events.map((event) => ({
      id: event.id,
      type: event.type,
      data: structuredClone(event.data)
    }));
  }

  isConfigured(): boolean {
    return this.config.enabled && typeof this.config.dsn === "string" && this.config.dsn.trim().length > 0;
  }

  private ensureInitialized(): void {
    if (this.initialized || !this.isConfigured()) {
      return;
    }

    this.sdk.init({
      dsn: this.config.dsn,
      environment: this.config.environment
    });
    this.initialized = true;
  }
}

export const createSentryEventId = (): string => randomUUID();
