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
  private readonly webhooks = new Map<string, WebhookConfig[]>();

  constructor(
    configs?: WebhookConfig[],
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (configs) {
      this.webhooks.set(this.getBucketKey(null), configs.map((config) => this.cloneWebhook(config)));
    }
  }

  registerWebhook(config: WebhookConfig, tenantId?: string | null): void {
    const nextConfig = this.cloneWebhook(config);
    const bucketKey = this.getBucketKey(tenantId);
    const webhooks = this.webhooks.get(bucketKey) ?? [];
    const existingIndex = webhooks.findIndex((webhook) => webhook.url === nextConfig.url);

    if (existingIndex >= 0) {
      webhooks[existingIndex] = nextConfig;
      this.webhooks.set(bucketKey, webhooks);
      return;
    }

    webhooks.push(nextConfig);
    this.webhooks.set(bucketKey, webhooks);
  }

  removeWebhook(url: string, tenantId?: string | null): void {
    const bucketKey = this.getBucketKey(tenantId);
    const webhooks = this.webhooks.get(bucketKey) ?? [];

    this.webhooks.set(
      bucketKey,
      webhooks.filter((webhook) => webhook.url !== url)
    );
  }

  listWebhooks(tenantId?: string | null): WebhookConfig[] {
    return (this.webhooks.get(this.getBucketKey(tenantId)) ?? []).map((webhook) =>
      this.cloneWebhook(webhook)
    );
  }

  async emit(
    event: string,
    data: Record<string, unknown>,
    tenantId?: string | null
  ): Promise<{ sent: number; failed: number }> {
    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data
    };
    const serializedPayload = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;

    for (const webhook of this.webhooks.get(this.getBucketKey(tenantId)) ?? []) {
      if (!webhook.enabled || !webhook.events.includes(event)) {
        continue;
      }

      try {
        const signature = webhook.secret
          ? this.signPayload(serializedPayload, webhook.secret)
          : undefined;
        const response = await this.fetchImpl(webhook.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(signature === undefined ? {} : { "x-vega-signature": signature })
          },
          body: serializedPayload
        });

        if (response.ok) {
          sent += 1;
        } else {
          failed += 1;
        }
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
  }, tenantId?: string | null): Promise<void> {
    await this.emit("memory.created", memory, tenantId);
  }

  async emitMemoryUpdated(id: string, tenantId?: string | null): Promise<void> {
    await this.emit("memory.updated", { id }, tenantId);
  }

  async emitMemoryDeleted(id: string, tenantId?: string | null): Promise<void> {
    await this.emit("memory.deleted", { id }, tenantId);
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

  private getBucketKey(tenantId: string | null | undefined): string {
    return tenantId ?? "__root__";
  }
}
