const DEFAULT_ALERT_TIMEOUT_MS = 5_000;
const DEFAULT_ALERT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

export interface AlertPayload {
  alert_id: string;
  severity: "info" | "warn" | "critical";
  value: number;
  threshold: number;
  fired_at: string;
  message: string;
}

export type AlertDispatchResult = { status: "ok" } | { status: "error"; message: string };

export interface AlertChannel {
  id: string;
  send(payload: AlertPayload): Promise<AlertDispatchResult>;
}

export interface CreateWebhookChannelOptions {
  id: string;
  url: string;
  headers?: Record<string, string>;
  method?: "POST";
  timeoutMs?: number;
  retryDelaysMs?: number[];
  bodyFactory?: (payload: AlertPayload) => unknown;
}

const wait = async (delayMs: number): Promise<void> => {
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
};

const formatHttpError = (status: number, statusText: string): string =>
  `HTTP ${status}${statusText.length > 0 ? ` ${statusText}` : ""}`;

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createWebhookChannel(options: CreateWebhookChannelOptions): AlertChannel {
  const method = options.method ?? "POST";
  const timeoutMs = options.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? [...DEFAULT_ALERT_RETRY_DELAYS_MS];
  const bodyFactory = options.bodyFactory ?? ((payload: AlertPayload) => payload);

  return {
    id: options.id,
    async send(payload: AlertPayload): Promise<AlertDispatchResult> {
      const requestBody = JSON.stringify(bodyFactory(payload));
      const attempts = Math.max(1, retryDelaysMs.length);

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await globalThis.fetch(options.url, {
            method,
            headers: {
              "content-type": "application/json",
              ...options.headers
            },
            body: requestBody,
            signal: controller.signal
          });

          if (response.ok) {
            return { status: "ok" };
          }

          const message = formatHttpError(response.status, response.statusText);
          const shouldRetry = response.status >= 500 && attempt < attempts - 1;

          if (shouldRetry) {
            await wait(retryDelaysMs[attempt] ?? 0);
            continue;
          }

          return {
            status: "error",
            message
          };
        } catch (error) {
          if (attempt < attempts - 1) {
            await wait(retryDelaysMs[attempt] ?? 0);
            continue;
          }

          return {
            status: "error",
            message: formatError(error)
          };
        } finally {
          clearTimeout(timeout);
        }
      }

      return {
        status: "error",
        message: "Alert delivery failed."
      };
    }
  };
}
