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

function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function validateSlackWebhookUrl(raw: string): string {
  const url = new URL(raw);

  if (url.protocol !== "https:") {
    throw new Error(`Slack webhook URL must use https: ${url.protocol}`);
  }

  if (!["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname)) {
    throw new Error(`Slack webhook URL must target hooks.slack.com: ${url.hostname}`);
  }

  if (!url.pathname.startsWith("/services/")) {
    throw new Error(`Slack webhook URL must use a /services/ path: ${url.pathname}`);
  }

  return url.toString();
}

const toSlackText = (payload: AlertPayload): string =>
  `*${escapeSlackText(payload.severity)}: ${escapeSlackText(payload.alert_id)}*\nValue: ${payload.value}\nThreshold: ${payload.threshold}\n${escapeSlackText(payload.message)}`;

export function createSlackChannel(options: CreateSlackChannelOptions): AlertChannel {
  const url = validateSlackWebhookUrl(options.url);

  return createWebhookChannel({
    id: options.id,
    url,
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
