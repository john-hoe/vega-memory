// Webhook integration stub — replace log statements with actual HTTP POST to connect Jira/GitHub/custom endpoints.
import { createHmac } from "node:crypto";

export interface WebhookConfig {
  url: string;
  secret?: string;
  events: string[];
  enabled: boolean;
}

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export class WebhookService {
  private webhooks: WebhookConfig[] = [];

  constructor(configs?: WebhookConfig[]) {
    this.webhooks = configs?.map((config) => this.cloneWebhook(config)) ?? [];
  }

  registerWebhook(config: WebhookConfig): void {
    const nextConfig = this.cloneWebhook(config);
    const existingIndex = this.webhooks.findIndex((webhook) => webhook.url === nextConfig.url);

    if (existingIndex >= 0) {
      this.webhooks[existingIndex] = nextConfig;
      return;
    }

    this.webhooks.push(nextConfig);
  }

  removeWebhook(url: string): void {
    this.webhooks = this.webhooks.filter((webhook) => webhook.url !== url);
  }

  listWebhooks(): WebhookConfig[] {
    return this.webhooks.map((webhook) => this.cloneWebhook(webhook));
  }

  async emit(
    event: string,
    data: Record<string, unknown>
  ): Promise<{ sent: number; failed: number }> {
    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data
    };
    const serializedPayload = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;

    for (const webhook of this.webhooks) {
      if (!webhook.enabled || !webhook.events.includes(event)) {
        continue;
      }

      try {
        if (webhook.secret) {
          this.signPayload(serializedPayload, webhook.secret);
        }

        console.log(`Webhook would fire: ${webhook.url} ${event}`);
        sent += 1;
      } catch {
        failed += 1;
      }
    }

    return { sent, failed };
  }

  async emitMemoryCreated(memory: {
    id: string;
    content: string;
    project: string;
  }): Promise<void> {
    await this.emit("memory.created", memory);
  }

  async emitMemoryUpdated(id: string): Promise<void> {
    await this.emit("memory.updated", { id });
  }

  async emitMemoryDeleted(id: string): Promise<void> {
    await this.emit("memory.deleted", { id });
  }

  signPayload(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }

  private cloneWebhook(config: WebhookConfig): WebhookConfig {
    return {
      url: config.url,
      events: [...config.events],
      enabled: config.enabled,
      ...(config.secret === undefined ? {} : { secret: config.secret })
    };
  }
}
