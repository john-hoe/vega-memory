import {
  createWebhookChannel,
  type AlertChannel,
  type AlertPayload
} from "./webhook.js";

export interface CreateSlackChannelOptions {
  id: string;
  url: string;
  timeoutMs?: number;
  retryDelaysMs?: number[];
}

const toSlackText = (payload: AlertPayload): string =>
  `*${payload.severity}: ${payload.alert_id}*\nValue: ${payload.value}\nThreshold: ${payload.threshold}\n${payload.message}`;

export function createSlackChannel(options: CreateSlackChannelOptions): AlertChannel {
  return createWebhookChannel({
    id: options.id,
    url: options.url,
    timeoutMs: options.timeoutMs,
    retryDelaysMs: options.retryDelaysMs,
    bodyFactory: (payload) => ({
      text: `${payload.severity}: ${payload.alert_id}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: toSlackText(payload)
          }
        }
      ]
    })
  });
}
