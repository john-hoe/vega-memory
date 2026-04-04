import type { VegaConfig } from "../config.js";
import { AlertFileWriter } from "./alert-file.js";
import { TelegramNotifier } from "./telegram.js";

const formatAlert = (icon: string, title: string, detail: string): string =>
  `${icon} *${title}*\n${detail}`;

export class NotificationManager {
  readonly #telegramNotifier: TelegramNotifier | null;
  readonly #alertFileWriter: AlertFileWriter;

  constructor(config: VegaConfig, alertDir: string) {
    this.#telegramNotifier =
      config.telegramBotToken !== undefined && config.telegramChatId !== undefined
        ? new TelegramNotifier(config.telegramBotToken, config.telegramChatId)
        : null;
    this.#alertFileWriter = new AlertFileWriter(alertDir);
  }

  async notifyError(title: string, detail: string): Promise<void> {
    if (this.#telegramNotifier !== null) {
      await this.#telegramNotifier.sendError(title, detail);
    }

    this.#alertFileWriter.write(formatAlert("🔴", title, detail));
  }

  async notifyWarning(title: string, detail: string): Promise<void> {
    if (this.#telegramNotifier !== null) {
      await this.#telegramNotifier.sendWarning(title, detail);
    }

    this.#alertFileWriter.write(formatAlert("🟡", title, detail));
  }

  async notifyWeekly(report: string): Promise<void> {
    if (this.#telegramNotifier !== null) {
      await this.#telegramNotifier.sendWeeklyReport(report);
    }
  }

  clearAlert(): void {
    this.#alertFileWriter.clear();
  }
}
