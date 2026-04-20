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

const toTelegramText = (payload: AlertPayload): string =>
  `*${payload.severity}: ${payload.alert_id}*\nValue: ${payload.value}\nThreshold: ${payload.threshold}\n${payload.message}`;

export function createTelegramChannel(options: CreateTelegramChannelOptions): AlertChannel {
  return createWebhookChannel({
    id: options.id,
    url: `https://api.telegram.org/bot${options.botToken}/sendMessage`,
    timeoutMs: options.timeoutMs,
    retryDelaysMs: options.retryDelaysMs,
    bodyFactory: (payload: AlertPayload) => ({
      chat_id: options.chatId,
      text: toTelegramText(payload),
      parse_mode: "Markdown"
    })
  });
}
