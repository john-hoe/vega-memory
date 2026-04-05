import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import {
  ARCHIVED_EXPORT_METADATA_KEY,
  LifecycleManager
} from "../core/lifecycle.js";
import { RecallService } from "../core/recall.js";
import type { Memory, SearchResult } from "../core/types.js";
import { Repository } from "../db/repository.js";
import { NotificationManager } from "../notify/manager.js";
import {
  decryptBuffer,
  encryptBuffer,
  generateKey
} from "../security/encryption.js";
import { shouldExclude } from "../security/exclusion.js";
import { SearchEngine } from "../search/engine.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const baseConfig: VegaConfig = {
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
  observerEnabled: false,
};

const createArchivedMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "archived-memory",
  type: "decision",
  project: "vega",
  title: "Archived Memory",
  content: "Archived content",
  embedding: null,
  importance: 0.4,
  source: "auto",
  tags: ["archive"],
  created_at: new Date(Date.now() - 100 * DAY_MS).toISOString(),
  updated_at: new Date(Date.now() - 100 * DAY_MS).toISOString(),
  accessed_at: new Date(Date.now() - 100 * DAY_MS).toISOString(),
  status: "archived",
  verified: "unverified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const createLifecycleHarness = () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-lifecycle-"));
  const config: VegaConfig = {
    ...baseConfig,
    dbPath: join(tempDir, "memory.db"),
    cacheDbPath: join(tempDir, "cache.db")
  };
  const repository = new Repository(config.dbPath);
  const notificationManager = new NotificationManager(config, join(tempDir, "alerts"));
  const lifecycleManager = new LifecycleManager(
    repository,
    notificationManager,
    config
  );

  return {
    repository,
    lifecycleManager,
    cleanup(): void {
      repository.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  };
};

test("encryptBuffer and decryptBuffer round-trip", () => {
  const key = generateKey();
  const data = Buffer.from("vega-memory-roundtrip", "utf8");
  const encrypted = encryptBuffer(data, key);

  assert.equal(encrypted.equals(data), false);
  assert.equal(decryptBuffer(encrypted, key).toString("utf8"), "vega-memory-roundtrip");
});

test("decryptBuffer throws with the wrong key", () => {
  const encrypted = encryptBuffer(Buffer.from("secret", "utf8"), generateKey());

  assert.throws(() => decryptBuffer(encrypted, generateKey()));
});

test("generateKey returns a 64-character hex string", () => {
  assert.match(generateKey(), /^[0-9a-f]{64}$/);
});

test("shouldExclude detects emotional content", () => {
  assert.deepEqual(shouldExclude("fuck this"), {
    excluded: true,
    reason: "emotional complaint without actionable content"
  });
});

test("shouldExclude allows normal technical content", () => {
  assert.deepEqual(
    shouldExclude("Need to fix the SQLite write path by serializing sync queue updates."),
    {
      excluded: false,
      reason: ""
    }
  );
});

test("shouldExclude detects raw data dumps", () => {
  const dump = `${"{[]}:0123456789".repeat(180)}${"abc".repeat(30)}`;

  assert.deepEqual(shouldExclude(dump), {
    excluded: true,
    reason: "raw data dump"
  });
});

test("shouldExclude detects one-time commands", () => {
  assert.deepEqual(shouldExclude("Run npm install and restart the server"), {
    excluded: true,
    reason: "one-time command"
  });
});

test("shouldExclude detects non-coding tasks", () => {
  assert.deepEqual(shouldExclude("Write an email to the vendor about tomorrow's meeting"), {
    excluded: true,
    reason: "non-coding task"
  });
});

test("graceful deletion finds memories archived for more than 83 days", () => {
  const harness = createLifecycleHarness();

  try {
    harness.repository.createMemory(
      createArchivedMemory({
        id: "pending-old",
        updated_at: new Date(Date.now() - 84 * DAY_MS).toISOString()
      })
    );
    harness.repository.createMemory(
      createArchivedMemory({
        id: "pending-recent",
        updated_at: new Date(Date.now() - 20 * DAY_MS).toISOString()
      })
    );

    const status = harness.lifecycleManager.checkPendingDeletions();

    assert.deepEqual(
      status.pending.map((memory) => memory.id),
      ["pending-old"]
    );
    assert.ok(status.daysUntilDeletion <= 7);
    assert.equal(status.userAcknowledged, false);
  } finally {
    harness.cleanup();
  }
});

test("graceful deletion never deletes explicit source memories", async () => {
  const harness = createLifecycleHarness();

  try {
    harness.repository.createMemory(
      createArchivedMemory({
        id: "auto-delete",
        updated_at: new Date(Date.now() - 91 * DAY_MS).toISOString()
      })
    );
    harness.repository.createMemory(
      createArchivedMemory({
        id: "explicit-keep",
        source: "explicit",
        updated_at: new Date(Date.now() - 91 * DAY_MS).toISOString()
      })
    );

    await harness.lifecycleManager.notifyPendingDeletions([
      harness.repository.getMemory("auto-delete") as Memory
    ]);
    harness.repository.setMetadata(
      ARCHIVED_EXPORT_METADATA_KEY,
      new Date().toISOString()
    );

    const result = harness.lifecycleManager.executeDeletion();

    assert.equal(result.deleted, 1);
    assert.equal(result.blocked, 1);
    assert.equal(harness.repository.getMemory("auto-delete"), null);
    assert.ok(harness.repository.getMemory("explicit-keep"));
  } finally {
    harness.cleanup();
  }
});

test("graceful deletion keeps export acknowledgement after reminder notifications", async () => {
  const harness = createLifecycleHarness();

  try {
    harness.repository.createMemory(
      createArchivedMemory({
        id: "auto-delete-after-export",
        updated_at: new Date(Date.now() - 91 * DAY_MS).toISOString()
      })
    );
    const pendingMemory = harness.repository.getMemory("auto-delete-after-export") as Memory;

    await harness.lifecycleManager.notifyPendingDeletions([pendingMemory]);
    harness.repository.setMetadata(
      ARCHIVED_EXPORT_METADATA_KEY,
      new Date(Date.now() + 1_000).toISOString()
    );
    await harness.lifecycleManager.notifyPendingDeletions([pendingMemory]);

    const result = harness.lifecycleManager.executeDeletion();

    assert.equal(result.deleted, 1);
    assert.equal(result.blocked, 0);
    assert.equal(harness.repository.getMemory("auto-delete-after-export"), null);
  } finally {
    harness.cleanup();
  }
});

test("cross-project auto-promotion triggers at 2 projects", async () => {
  const repository = new Repository(":memory:");
  const memory = createArchivedMemory({
    id: "shared-memory",
    status: "active",
    source: "auto",
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    accessed_at: new Date().toISOString(),
    content: "Shared project knowledge",
    scope: "project",
    accessed_projects: ["project-a"]
  });
  const searchEngine = {
    search(): SearchResult[] {
      return [
        {
          memory: repository.getMemory("shared-memory") as Memory,
          similarity: 0.9,
          finalScore: 0.9
        }
      ];
    }
  } as unknown as SearchEngine;
  const recallService = new RecallService(repository, searchEngine, baseConfig);

  try {
    repository.createMemory(memory);

    await recallService.recall("shared", {
      project: "project-b",
      limit: 5,
      minSimilarity: 0
    });

    const updated = repository.getMemory("shared-memory");

    assert.ok(updated);
    assert.equal(updated.scope, "global");
    assert.deepEqual(updated.accessed_projects.sort(), ["project-a", "project-b"]);
  } finally {
    repository.close();
  }
});
