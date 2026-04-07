// Slack integration stub — implement webhook POST to connect. See: https://api.slack.com/messaging/webhooks

export interface SlackConfig {
  webhookUrl?: string;
  botToken?: string;
  defaultChannel?: string;
  enabled: boolean;
}

export interface SlackMessage {
  channel?: string;
  text: string;
  blocks?: unknown[];
}

interface SlackMemoryNotification {
  id: string;
  content: string;
  project: string;
}

export class SlackIntegration {
  constructor(private readonly config: SlackConfig) {}

  async sendMessage(msg: SlackMessage): Promise<boolean> {
    if (!this.config.enabled) {
      console.log("Slack not configured");
      return false;
    }

    if (!this.config.webhookUrl) {
      throw new Error("Slack webhook URL is required when Slack integration is enabled");
    }

    console.log("Slack message would be sent:", {
      ...msg,
      channel: msg.channel ?? this.config.defaultChannel
    });
    return true;
  }

  async sendMemoryNotification(memory: SlackMemoryNotification): Promise<boolean> {
    return this.sendMessage({
      channel: this.config.defaultChannel,
      text: `[${memory.project}] Memory ${memory.id}: ${memory.content}`
    });
  }

  async sendDigestNotification(summary: string): Promise<boolean> {
    return this.sendMessage({
      channel: this.config.defaultChannel,
      text: summary
    });
  }

  isConfigured(): boolean {
    return this.config.enabled && this.config.webhookUrl !== undefined;
  }
}
