const TELEGRAM_TIMEOUT_MS = 5_000;

interface TelegramSendResponse {
  ok?: unknown;
}

const withTimeout = async (input: string, init: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, TELEGRAM_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
};

export class TelegramNotifier {
  readonly #botToken: string;
  readonly #chatId: string;

  constructor(botToken: string, chatId: string) {
    this.#botToken = botToken;
    this.#chatId = chatId;
  }

  async send(message: string): Promise<boolean> {
    try {
      const response = await withTimeout(
        `https://api.telegram.org/bot${this.#botToken}/sendMessage`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            chat_id: this.#chatId,
            text: message,
            parse_mode: "Markdown"
          })
        }
      );

      if (!response.ok) {
        return false;
      }

      const payload = (await response.json()) as TelegramSendResponse;
      return payload.ok === true;
    } catch {
      return false;
    }
  }

  async sendError(title: string, detail: string): Promise<void> {
    await this.send(`🔴 *${title}*\n${detail}`);
  }

  async sendWarning(title: string, detail: string): Promise<void> {
    await this.send(`🟡 *${title}*\n${detail}`);
  }

  async sendWeeklyReport(report: string): Promise<void> {
    await this.send(`📊 *Weekly Report*\n${report}`);
  }
}
