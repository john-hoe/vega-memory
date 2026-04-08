import { randomUUID } from "node:crypto";

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

export class SentryStub {
  private readonly events: SentryEvent[] = [];
  private user?: SentryUser;
  private readonly tags = new Map<string, string>();

  constructor(private readonly config: SentryStubConfig) {}

  captureException(error: Error, context?: Record<string, unknown>): string {
    const id = randomUUID();

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
    const id = randomUUID();

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
  }

  setTag(key: string, value: string): void {
    this.tags.set(key, value);
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
}
