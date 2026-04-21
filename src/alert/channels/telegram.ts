import {
  createWebhookChannel,
  type AlertChannel,
  type AlertPayload
} from "./webhook.js";

export interface CreateTelegramChannelOptions {
  id: string;
  botToken: string;
  chatId: string;
  timeoutMs?: number;
  retryDelaysMs?: number[];
}

function escapeTelegramMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

const toTelegramText = (payload: AlertPayload): string =>
  `*${escapeTelegramMarkdown(payload.severity)}: ${escapeTelegramMarkdown(payload.alert_id)}*\nValue: ${payload.value}\nThreshold: ${payload.threshold}\n${escapeTelegramMarkdown(payload.message)}`;

export function createTelegramChannel(options: CreateTelegramChannelOptions): AlertChannel {
  return createWebhookChannel({
    id: options.id,
    url: `https://api.telegram.org/bot${options.botToken}/sendMessage`,
    timeoutMs: options.timeoutMs,
    retryDelaysMs: options.retryDelaysMs,
    bodyFactory: (payload: AlertPayload) => ({
      chat_id: options.chatId,
      text: toTelegramText(payload),
      parse_mode: "MarkdownV2"
    })
  });
}
