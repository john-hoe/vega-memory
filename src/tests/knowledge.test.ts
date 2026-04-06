import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { CodeIndexService } from "../core/code-index.js";
import { DocIndexService } from "../core/doc-index.js";
import { GitHistoryService } from "../core/git-history.js";
import { ImageMemoryService } from "../core/image-memory.js";
import { KnowledgeGraphService } from "../core/knowledge-graph.js";
import { MemoryService } from "../core/memory.js";
import { Repository } from "../db/repository.js";
import type { Memory } from "../core/types.js";
import { embeddingCache } from "../embedding/cache.js";
import { createMCPServer } from "../mcp/server.js";

const baseConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined,
  observerEnabled: false,
  dbEncryption: false,
};

const createMemory = (
  overrides: Partial<Omit<Memory, "access_count">> = {}
): Omit<Memory, "access_count"> => {
  const { summary = null, ...rest } = overrides;

  return {
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
    ...rest,
    summary
  };
};

const installEmbeddingMock = (): (() => void) => {
  const originalFetch = globalThis.fetch;
  embeddingCache.clear();

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
    embeddingCache.clear();
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
  const memoryService = new MemoryService(repository, baseConfig);
  const service = new CodeIndexService(repository, memoryService);

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

test("MemoryService.update re-links knowledge graph after content changes", async () => {
  const restoreFetch = installEmbeddingMock();
  const repository = new Repository(":memory:");
  const graphService = new KnowledgeGraphService(repository);
  const memoryService = new MemoryService(repository, baseConfig, graphService);

  try {
    const stored = await memoryService.store({
      content: "Vega Memory uses SQLite for storage.",
      type: "project_context",
      project: "vega",
      source: "explicit"
    });

    assert.deepEqual(
      graphService.query("SQLite", 1).memories.map((memory) => memory.id),
      [stored.id]
    );

    await memoryService.update(stored.id, {
      content: "Vega Memory uses Ollama for embeddings."
    });

    assert.deepEqual(graphService.query("SQLite", 1).memories, []);
    assert.deepEqual(
      graphService.query("Ollama", 1).memories.map((memory) => memory.id),
      [stored.id]
    );

    const updated = repository.getMemory(stored.id);
    assert.ok(updated);
    assert.equal(updated.tags.includes("sqlite"), false);
    assert.equal(updated.tags.includes("ollama"), true);
  } finally {
    restoreFetch();
    repository.close();
  }
});

test("CodeIndexService.indexDirectory stores embeddings and skips vendor directories", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-code-index-dir-"));
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const service = new CodeIndexService(repository, memoryService);

  mkdirSync(join(tempDir, "src"), { recursive: true });
  mkdirSync(join(tempDir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "index.ts"),
    ["export default class App {}", "export async function run(): Promise<void> {}"].join(
      "\n"
    ),
    "utf8"
  );
  writeFileSync(
    join(tempDir, "node_modules", "pkg", "index.ts"),
    "export class Ignored {}",
    "utf8"
  );

  try {
    const indexed = await service.indexDirectory(tempDir, ["ts"]);
    const memories = repository.listMemories({
      project: basename(tempDir),
      type: "project_context",
      limit: 10
    });

    assert.equal(indexed, 1);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].title, "Code Index: src/index.ts");
    assert.ok(memories[0].embedding);
    assert.deepEqual(
      service.searchSymbol("run").map((memory) => memory.id),
      [memories[0].id]
    );
  } finally {
    restoreFetch();
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

test("GitHistoryService.extractFromGitLog keeps distinct commits with duplicate subjects", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-git-history-dup-"));
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

  writeFileSync(join(repoPath, "one.txt"), "one\n", "utf8");
  execFileSync("git", ["-C", repoPath, "add", "one.txt"], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "feat: repeated subject"], {
    encoding: "utf8"
  });

  writeFileSync(join(repoPath, "two.txt"), "two\n", "utf8");
  execFileSync("git", ["-C", repoPath, "add", "two.txt"], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "feat: repeated subject"], {
    encoding: "utf8"
  });

  try {
    const imported = await service.extractFromGitLog(repoPath, undefined, 10);
    const memories = repository.listMemories({
      project: "repo",
      type: "decision",
      limit: 10
    });

    assert.equal(imported, 2);
    assert.equal(memories.length, 2);
    assert.equal(new Set(memories.map((memory) => memory.tags.find((tag) => tag !== "git" && tag !== "repo"))).size, 2);
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ImageMemoryService.storeScreenshot updates within a project and keeps cross-project copies separate", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-image-memory-"));
  const imagePath = join(tempDir, "shot.png");
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const service = new ImageMemoryService(repository, memoryService);

  writeFileSync(imagePath, Buffer.from("image-data"));

  try {
    const projectAFirst = await service.storeScreenshot(imagePath, "Initial capture", "alpha");
    const projectASecond = await service.storeScreenshot(imagePath, "Updated capture", "alpha");
    const projectB = await service.storeScreenshot(imagePath, "Shared capture", "beta");

    assert.equal(projectAFirst, projectASecond);
    assert.notEqual(projectAFirst, projectB);
    assert.match(repository.getMemory(projectAFirst)?.content ?? "", /^Updated capture/);
    assert.equal(service.listScreenshots("alpha").length, 1);
    assert.equal(service.listScreenshots("beta").length, 1);
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
    assert.equal(memories.every((memory) => memory.embedding !== null), true);
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DocIndexService.indexDirectory keeps same-basename files distinct", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-doc-index-dir-"));
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const service = new DocIndexService(repository, memoryService);

  mkdirSync(join(tempDir, "a"), { recursive: true });
  mkdirSync(join(tempDir, "b"), { recursive: true });
  writeFileSync(join(tempDir, "a", "guide.md"), "## Setup\n\nAlpha section\n", "utf8");
  writeFileSync(join(tempDir, "b", "guide.md"), "## Setup\n\nBeta section\n", "utf8");

  try {
    const count = await service.indexDirectory(tempDir, "docs", ["md"]);
    const titles = repository
      .listMemories({
        project: "docs",
        type: "project_context",
        limit: 10
      })
      .map((memory) => memory.title)
      .sort();

    assert.equal(count, 2);
    assert.deepEqual(titles, ["a/guide.md: Setup", "b/guide.md: Setup"]);
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("memory_graph tool omits serialized embeddings", async () => {
  const repository = new Repository(":memory:");
  const server = createMCPServer({
    repository,
    graphService: {
      query: () => ({
        entity: {
          id: "entity-1",
          name: "Vega Memory",
          type: "project",
          created_at: "2026-04-05T00:00:00.000Z"
        },
        relations: [],
        memories: [
          {
            ...createMemory({
              id: "memory-graph",
              embedding: Buffer.from([1, 2, 3])
            }),
            access_count: 0
          }
        ]
      })
    },
    memoryService: {
      store: async () => ({ id: "noop", action: "created", title: "noop" }),
      update: async () => {},
      delete: async () => {}
    },
    recallService: {
      recall: async () => [],
      listMemories: () => []
    },
    sessionService: {
      sessionStart: async () => ({
        project: "vega",
        active_tasks: [],
        preferences: [],
        context: [],
        relevant: [],
        recent_unverified: [],
        conflicts: [],
        proactive_warnings: [],
        token_estimate: 0
      }),
      sessionEnd: async () => {}
    },
    compactService: {
      compact: () => ({ merged: 0, archived: 0 })
    },
    config: baseConfig
  });

  try {
    const registeredTools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: { entity: string; depth: number }, extra: object) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools;
    const result = await registeredTools.memory_graph.handler(
      {
        entity: "Vega Memory",
        depth: 1
      },
      {}
    );
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      memories: Array<Record<string, unknown>>;
    };

    assert.equal("embedding" in payload.memories[0], false);
  } finally {
    repository.close();
    await server.close();
  }
});
