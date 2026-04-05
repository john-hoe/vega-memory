import assert from "node:assert/strict";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { CompressionService } from "../core/compression.js";
import { DocGenerator } from "../core/doc-generator.js";
import { ExtractionService } from "../core/extraction.js";
import { MemoryService } from "../core/memory.js";
import { ObserverService } from "../core/observer.js";
import { QualityService } from "../core/quality.js";
import type { Memory } from "../core/types.js";
import { Repository } from "../db/repository.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  backupRetentionDays: 7,
  observerEnabled: false,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
};

const createStoredMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  type: "decision",
  project: "vega",
  title: "Stored Memory",
  content: "Use SQLite for memory storage.",
  embedding: null,
  importance: 0.5,
  source: "auto",
  tags: ["sqlite"],
  created_at: "2026-04-03T00:00:00.000Z",
  updated_at: "2026-04-03T00:00:00.000Z",
  accessed_at: "2026-04-03T00:00:00.000Z",
  status: "active",
  verified: "unverified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

test("CompressionService skips short memories (< 500 chars)", async () => {
  const repository = new Repository(":memory:");
  const compressionService = new CompressionService(repository, baseConfig);
  const content = "Short note that should not be compressed.";

  try {
    repository.createMemory(
      createStoredMemory({
        id: "short-memory",
        content
      })
    );

    const result = await compressionService.compressMemory("short-memory");

    assert.deepEqual(result, {
      original_length: content.length,
      compressed_length: content.length
    });
    assert.equal(repository.getMemory("short-memory")?.content, content);
  } finally {
    repository.close();
  }
});

test("ExtractionService returns empty array when Ollama unavailable", async () => {
  const extractionService = new ExtractionService({
    ...baseConfig,
    ollamaBaseUrl: "http://localhost:99999"
  });

  assert.deepEqual(
    await extractionService.extractMemories("We decided to use SQLite.", "vega"),
    []
  );
});

test("DocGenerator.generateProjectReadme produces valid markdown with sections", () => {
  const repository = new Repository(":memory:");
  const docGenerator = new DocGenerator(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "decision",
        type: "decision",
        title: "Use SQLite",
        content: "Use SQLite for local persistence."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "pitfall",
        type: "pitfall",
        title: "WAL backups",
        content: "Checkpoint WAL files before backups."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "task",
        type: "task_state",
        title: "Ship CLI",
        content: "Finish the CLI integration."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "context",
        type: "project_context",
        title: "Runtime",
        content: "The tool stores memories in SQLite."
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "preference",
        type: "preference",
        project: "shared",
        scope: "global",
        title: "Concise output",
        content: "Prefer concise answers."
      })
    );

    const readme = docGenerator.generateProjectReadme("vega");

    assert.match(readme, /^# vega README/m);
    assert.match(readme, /^## Architecture Decisions/m);
    assert.match(readme, /^## Known Pitfalls/m);
    assert.match(readme, /^## Active Tasks/m);
    assert.match(readme, /^## Project Context/m);
    assert.match(readme, /^## Preferences/m);
  } finally {
    repository.close();
  }
});

test("DocGenerator.generateDecisionLog lists decisions chronologically", () => {
  const repository = new Repository(":memory:");
  const docGenerator = new DocGenerator(repository);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "decision-early",
        title: "Early decision",
        content: "Choose SQLite first.",
        created_at: "2026-04-01T00:00:00.000Z"
      })
    );
    repository.createMemory(
      createStoredMemory({
        id: "decision-late",
        title: "Later decision",
        content: "Add compression later.",
        created_at: "2026-04-02T00:00:00.000Z"
      })
    );

    const decisionLog = docGenerator.generateDecisionLog("vega");

    assert.equal(
      decisionLog.indexOf("Early decision") < decisionLog.indexOf("Later decision"),
      true
    );
  } finally {
    repository.close();
  }
});

test("QualityService.scoreMemory returns correct score for verified memory", () => {
  const repository = new Repository(":memory:");
  const qualityService = new QualityService(repository, baseConfig);

  try {
    const score = qualityService.scoreMemory({
      ...createStoredMemory({
        verified: "verified",
        updated_at: new Date().toISOString(),
        content: "x".repeat(200)
      }),
      access_count: 10
    });

    assert.equal(score.accuracy, 1);
    assert.equal(score.freshness, 1);
    assert.equal(score.usefulness, 1);
    assert.equal(score.completeness, 1);
    assert.equal(score.overall, 1);
  } finally {
    repository.close();
  }
});

test("QualityService.scoreMemory returns low score for rejected memory", () => {
  const repository = new Repository(":memory:");
  const qualityService = new QualityService(repository, baseConfig);

  try {
    const score = qualityService.scoreMemory({
      ...createStoredMemory({
        verified: "rejected",
        content: "Too short."
      }),
      access_count: 0
    });

    assert.equal(score.accuracy, 0);
    assert.equal(score.overall < 0.3, true);
  } finally {
    repository.close();
  }
});

test("QualityService.degradeLowQuality reduces importance", async () => {
  const repository = new Repository(":memory:");
  const qualityService = new QualityService(repository, baseConfig);

  try {
    repository.createMemory(
      createStoredMemory({
        id: "low-quality",
        verified: "rejected",
        importance: 0.5,
        content: "Too short."
      })
    );

    const degraded = await qualityService.degradeLowQuality();

    assert.equal(degraded, 1);
    assert.equal(repository.getMemory("low-quality")?.importance, 0.4);
  } finally {
    repository.close();
  }
});

test("ObserverService.shouldObserve returns true for Shell", () => {
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const observerService = new ObserverService(memoryService, {
    ...baseConfig,
    observerEnabled: true
  });

  try {
    assert.equal(observerService.shouldObserve("Shell"), true);
  } finally {
    repository.close();
  }
});
