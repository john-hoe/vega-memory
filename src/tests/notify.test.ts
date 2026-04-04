import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { AlertFileWriter } from "../notify/alert-file.js";
import { NotificationManager } from "../notify/manager.js";
import { TelegramNotifier } from "../notify/telegram.js";

const createConfig = (overrides: Partial<VegaConfig> = {}): VegaConfig => ({
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  ...overrides
});

test("AlertFileWriter supports write/read/clear", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-alert-file-"));
  const writer = new AlertFileWriter(tempDir);

  try {
    writer.write("🔴 *Disk Full*\nNo space left on device");
    assert.equal(writer.read(), "🔴 *Disk Full*\nNo space left on device");

    writer.clear();
    assert.equal(writer.read(), null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("TelegramNotifier.send returns false when the bot token is invalid", async () => {
  const notifier = new TelegramNotifier("0:invalid-token", "0");

  const sent = await notifier.send("Vega notification test");

  assert.equal(sent, false);
});

test("NotificationManager writes alert files when Telegram is not configured", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-notify-manager-"));
  const alertDir = join(tempDir, "alerts");
  const manager = new NotificationManager(createConfig(), alertDir);
  const writer = new AlertFileWriter(alertDir);

  try {
    await manager.notifyError("Daily Maintenance Errors", "Embedding regeneration failed");

    assert.equal(
      writer.read(),
      "🔴 *Daily Maintenance Errors*\nEmbedding regeneration failed"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("NotificationManager.clearAlert removes the active alert file", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-notify-clear-"));
  const alertDir = join(tempDir, "alerts");
  const manager = new NotificationManager(createConfig(), alertDir);
  const alertPath = join(alertDir, "active-alert.md");

  try {
    await manager.notifyWarning("Ollama Unavailable", "Ollama is unreachable");
    assert.equal(existsSync(alertPath), true);

    manager.clearAlert();
    assert.equal(existsSync(alertPath), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
