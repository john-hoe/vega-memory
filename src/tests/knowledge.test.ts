import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { CodeIndexService } from "../core/code-index.js";
import { DocIndexService } from "../core/doc-index.js";
import { GitHistoryService } from "../core/git-history.js";
import { KnowledgeGraphService } from "../core/knowledge-graph.js";
import { MemoryService } from "../core/memory.js";
import { Repository } from "../db/repository.js";
import type { Memory } from "../core/types.js";

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
  telegramChatId: undefined
};

const createMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => ({
  id: "memory-1",
  type: "project_context",
  project: "vega",
  title: "Vega Memory uses SQLite",
  content: "Vega Memory uses SQLite for local storage.",
  embedding: null,
  importance: 0.7,
  source: "explicit",
  tags: ["vega", "sqlite"],
  created_at: "2026-04-05T00:00:00.000Z",
  updated_at: "2026-04-05T00:00:00.000Z",
  accessed_at: "2026-04-05T00:00:00.000Z",
  status: "active",
  verified: "verified",
  scope: "project",
  accessed_projects: ["vega"],
  ...overrides
});

const installEmbeddingMock = (): (() => void) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input, init) => {
    if ((init?.method ?? "GET") === "POST") {
      return new Response(
        JSON.stringify({
          embeddings: [[0.1, 0.9]]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    return new Response(JSON.stringify({ version: "mock" }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
};

test("extractEntities finds tags as entities", () => {
  const repository = new Repository(":memory:");
  const service = new KnowledgeGraphService(repository);

  try {
    const entities = service.extractEntities("Vega Memory uses SQLite", ["project-alpha", "sqlite"]);

    assert.equal(entities.some((entity) => entity.name === "project-alpha"), true);
    assert.equal(entities.some((entity) => entity.name === "sqlite"), true);
    assert.equal(entities.some((entity) => entity.name === "Vega Memory"), true);
  } finally {
    repository.close();
  }
});

test("linkMemory creates entity and relation records", () => {
  const repository = new Repository(":memory:");
  const service = new KnowledgeGraphService(repository);

  try {
    repository.createMemory(createMemory());

    service.linkMemory("memory-1", [
      { name: "Vega Memory", type: "concept" },
      { name: "SQLite", type: "tool" }
    ]);

    const entity = repository.findEntity("Vega Memory");
    assert.ok(entity);

    const relations = repository.getEntityRelations(entity.id);

    assert.equal(relations.length, 1);
    assert.equal(relations[0].memory_id, "memory-1");
    assert.equal(relations[0].relation_type, "uses");
  } finally {
    repository.close();
  }
});

test("traverseGraph returns connected memories at depth 1", () => {
  const repository = new Repository(":memory:");
  const service = new KnowledgeGraphService(repository);

  try {
    repository.createMemory(createMemory());
    repository.createMemory(
      createMemory({
        id: "memory-2",
        title: "SQLite relates to Ollama",
        content: "SQLite relates to Ollama embeddings.",
        tags: ["sqlite", "ollama"]
      })
    );

    service.linkMemory("memory-1", [
      { name: "Vega Memory", type: "concept" },
      { name: "SQLite", type: "tool" }
    ]);
    service.linkMemory("memory-2", [
      { name: "SQLite", type: "tool" },
      { name: "Ollama", type: "tool" }
    ]);

    const result = service.query("SQLite", 1);

    assert.ok(result.entity);
    assert.deepEqual(
      result.memories.map((memory) => memory.id).sort(),
      ["memory-1", "memory-2"]
    );
  } finally {
    repository.close();
  }
});

test("CodeIndexService.indexFile extracts TypeScript class and function names", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-code-index-"));
  const filePath = join(tempDir, "example.ts");
  const repository = new Repository(":memory:");
  const service = new CodeIndexService(repository);

  writeFileSync(
    filePath,
    [
      "export class KnowledgeGraphService {}",
      "export function indexDirectory(): void {}",
      "const ignored = true;"
    ].join("\n"),
    "utf8"
  );

  try {
    const symbols = service.indexFile(filePath);

    assert.deepEqual(
      symbols.map((symbol) => ({ name: symbol.name, kind: symbol.kind })),
      [
        { name: "KnowledgeGraphService", kind: "class" },
        { name: "indexDirectory", kind: "function" }
      ]
    );
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GitHistoryService.extractFromGitLog creates memories from commits", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-git-history-"));
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const service = new GitHistoryService(repository, memoryService);
  const repoPath = join(tempDir, "repo");

  execFileSync("git", ["init", repoPath], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"], {
    encoding: "utf8"
  });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Test User"], {
    encoding: "utf8"
  });
  writeFileSync(join(repoPath, "README.md"), "# Vega\n", "utf8");
  execFileSync("git", ["-C", repoPath, "add", "README.md"], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "feat: add knowledge graph"], {
    encoding: "utf8"
  });

  try {
    const imported = await service.extractFromGitLog(repoPath, undefined, 10);
    const memories = repository.listMemories({
      project: "repo",
      limit: 10
    });

    assert.equal(imported, 1);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].content, "feat: add knowledge graph");
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DocIndexService.indexMarkdown splits by headings", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-doc-index-"));
  const filePath = join(tempDir, "guide.md");
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const service = new DocIndexService(repository, memoryService);

  writeFileSync(
    filePath,
    [
      "# Guide",
      "",
      "## Setup",
      "",
      "Install dependencies and configure Vega Memory.",
      "",
      "## Usage",
      "",
      "Run the CLI against the project directory.",
      ""
    ].join("\n"),
    "utf8"
  );

  try {
    const count = await service.indexMarkdown(filePath, "docs");
    const memories = repository.listMemories({
      project: "docs",
      type: "project_context",
      limit: 10
    });

    assert.equal(count, 2);
    assert.equal(memories.length, 2);
    assert.equal(readFileSync(filePath, "utf8").includes("## Setup"), true);
    assert.equal(memories.every((memory) => memory.content.includes("L0:")), true);
    assert.equal(memories.every((memory) => memory.content.includes("L1:")), true);
    assert.equal(memories.every((memory) => memory.content.includes("L2:")), true);
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
