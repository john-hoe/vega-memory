import type { VegaConfig } from "../config.js";
import { AlertFileWriter } from "./alert-file.js";
import { TelegramNotifier } from "./telegram.js";

const formatAlert = (icon: string, title: string, detail: string): string =>
  `${icon} *${title}*\n${detail}`;

interface WarningEntry {
  title: string;
  detail: string;
}

const formatDailyDigest = (warnings: WarningEntry[]): string =>
  warnings.map((warning, index) => `${index + 1}. *${warning.title}*\n${warning.detail}`).join("\n\n");

export class NotificationManager {
  readonly #telegramNotifier: TelegramNotifier | null;
  readonly #alertFileWriter: AlertFileWriter;
  readonly #warningBuffer: WarningEntry[] = [];

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
    this.queueWarning(title, detail);
  }

  queueWarning(title: string, detail: string): void {
    this.#warningBuffer.push({ title, detail });
  }

  async flushDailyDigest(): Promise<boolean> {
    if (this.#warningBuffer.length === 0) {
      return false;
    }

    const detail = formatDailyDigest(this.#warningBuffer);

    if (this.#telegramNotifier !== null) {
      await this.#telegramNotifier.sendWarning("Daily Warning Digest", detail);
    }

    this.#alertFileWriter.write(formatAlert("🟡", "Daily Warning Digest", detail));
    this.#warningBuffer.length = 0;
    return true;
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
