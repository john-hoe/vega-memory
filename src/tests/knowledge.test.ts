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
import { ImageAnalyzer, ImageMemoryService } from "../core/image-memory.js";
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

const createGraphServiceStub = (
  overrides: Partial<{
    query: KnowledgeGraphService["query"];
    getNeighbors: KnowledgeGraphService["getNeighbors"];
    shortestPath: KnowledgeGraphService["shortestPath"];
    graphStats: KnowledgeGraphService["graphStats"];
    subgraph: KnowledgeGraphService["subgraph"];
  }> = {}
) => ({
  query: () => ({
    entity: null,
    relations: [],
    memories: []
  }),
  getNeighbors: () => ({
    entity: null,
    neighbors: [],
    relations: [],
    memories: []
  }),
  shortestPath: () => ({
    from: null,
    to: null,
    entities: [],
    relations: [],
    memories: [],
    found: false
  }),
  graphStats: () => ({
    total_entities: 0,
    total_relations: 0,
    entity_types: {},
    relation_types: {},
    average_confidence: null,
    tracked_code_files: 0,
    tracked_doc_files: 0
  }),
  subgraph: () => ({
    seed_entities: [],
    missing_entities: [],
    entities: [],
    relations: [],
    memories: []
  }),
  ...overrides
});

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
    assert.equal(relations[0].confidence, 0.6);
    assert.equal(relations[0].extraction_method, "AMBIGUOUS");
  } finally {
    repository.close();
  }
});

test("createRelation persists explicit confidence metadata", () => {
  const repository = new Repository(":memory:");
  const service = new KnowledgeGraphService(repository);

  try {
    repository.createMemory(createMemory());
    const source = repository.createEntity("Source Node", "concept");
    const target = repository.createEntity("Target Node", "concept");

    service.createRelation(source.id, target.id, "related_to", "memory-1", {
      confidence: 0.42,
      extraction_method: "EXTRACTED"
    });

    const relations = repository.getEntityRelations(source.id);

    assert.equal(relations.length, 1);
    assert.equal(relations[0].confidence, 0.42);
    assert.equal(relations[0].extraction_method, "EXTRACTED");
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

test("replaceMemoryGraph infers indirect relations and query filters by confidence", () => {
  const repository = new Repository(":memory:");
  const service = new KnowledgeGraphService(repository);

  try {
    repository.createMemory(
      createMemory({
        id: "memory-graph",
        title: "Guide graph",
        content: "Guide graph memory"
      })
    );

    service.replaceMemoryGraph("memory-graph", {
      entities: [
        { name: "doc:guide.md", type: "document" },
        { name: "heading:guide.md#1:Setup", type: "heading" },
        { name: "term:sqlite", type: "term" }
      ],
      relations: [
        {
          source: "doc:guide.md",
          target: "heading:guide.md#1:Setup",
          relation_type: "contains"
        },
        {
          source: "heading:guide.md#1:Setup",
          target: "term:sqlite",
          relation_type: "defines"
        }
      ]
    });

    const fullResult = service.query("doc:guide.md", 2);
    const inferredRelation = fullResult.relations.find(
      (relation) => relation.extraction_method === "INFERRED"
    );

    assert.ok(inferredRelation);
    assert.equal(inferredRelation.relation_type, "related_to");
    assert.equal(inferredRelation.confidence, 0.85);
    assert.deepEqual(
      [inferredRelation.source_entity_name, inferredRelation.target_entity_name].sort(),
      ["doc:guide.md", "term:sqlite"]
    );

    const filteredResult = service.query("doc:guide.md", 2, 0.9);

    assert.equal(filteredResult.relations.length, 2);
    assert.equal(filteredResult.relations.every((relation) => relation.confidence >= 0.9), true);
    assert.equal(
      filteredResult.relations.every((relation) => relation.extraction_method === "EXTRACTED"),
      true
    );
  } finally {
    repository.close();
  }
});

test("getNeighbors excludes the root entity and shortestPath returns ordered BFS results", () => {
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

    const neighbors = service.getNeighbors("SQLite", 1, 0.5);
    const path = service.shortestPath("Vega Memory", "Ollama", 2);
    const missingPath = service.shortestPath("Vega Memory", "Missing Node", 2);

    assert.equal(neighbors.entity?.name, "SQLite");
    assert.deepEqual(neighbors.neighbors.map((entity) => entity.name).sort(), [
      "Ollama",
      "Vega Memory"
    ]);
    assert.equal(neighbors.neighbors.some((entity) => entity.name === "SQLite"), false);
    assert.equal(path.found, true);
    assert.deepEqual(
      path.entities.map((entity) => entity.name),
      ["Vega Memory", "SQLite", "Ollama"]
    );
    assert.equal(path.relations.length, 2);
    assert.deepEqual(
      path.memories.map((memory) => memory.id).sort(),
      ["memory-1", "memory-2"]
    );
    assert.equal(missingPath.found, false);
    assert.equal(missingPath.to, null);
  } finally {
    repository.close();
  }
});

test("subgraph merges multiple seeds and graphStats aggregates by project", () => {
  const repository = new Repository(":memory:");
  const service = new KnowledgeGraphService(repository);

  try {
    repository.createMemory(
      createMemory({
        id: "memory-vega",
        project: "vega",
        tags: ["sqlite", "vega"]
      })
    );
    repository.createMemory(
      createMemory({
        id: "memory-atlas",
        project: "atlas",
        title: "Atlas uses Redis",
        content: "Atlas uses Redis for caching.",
        tags: ["atlas", "redis"]
      })
    );

    const vegaSource = repository.createEntity("Vega Memory", "project");
    const vegaTarget = repository.createEntity("SQLite", "tool");
    const atlasSource = repository.createEntity("Atlas", "project");
    const atlasTarget = repository.createEntity("Redis", "tool");

    service.createRelation(vegaSource.id, vegaTarget.id, "uses", "memory-vega", {
      confidence: 0.8
    });
    service.createRelation(atlasSource.id, atlasTarget.id, "uses", "memory-atlas", {
      confidence: 0.4
    });

    const subgraph = service.subgraph(["Vega Memory", "Missing Node"], 1);
    const scopedStats = service.graphStats("vega");
    const globalStats = service.graphStats();

    assert.deepEqual(
      subgraph.seed_entities.map((entity) => entity.name),
      ["Vega Memory"]
    );
    assert.deepEqual(subgraph.missing_entities, ["Missing Node"]);
    assert.deepEqual(
      subgraph.entities.map((entity) => entity.name),
      ["Vega Memory", "SQLite"]
    );
    assert.equal(scopedStats.project, "vega");
    assert.equal(scopedStats.total_entities, 2);
    assert.equal(scopedStats.total_relations, 1);
    assert.equal(scopedStats.average_confidence, 0.8);
    assert.equal(globalStats.total_relations, 2);
    assert.equal(Math.abs((globalStats.average_confidence ?? 0) - 0.6) < 1e-9, true);
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

test("CodeIndexService.indexDirectory leaves structural graph disabled by default", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-code-index-no-graph-"));
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const graphService = new KnowledgeGraphService(repository);
  const service = new CodeIndexService(repository, memoryService);

  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    join(tempDir, "src", "index.ts"),
    ["import { join } from \"node:path\";", "export function run(): void {}", ""].join("\n"),
    "utf8"
  );

  try {
    await service.indexDirectory(tempDir, ["ts"]);

    const stats = graphService.getStats();

    assert.equal(stats.relation_types.imports ?? 0, 0);
    assert.equal(stats.relation_types.declares ?? 0, 0);
    assert.equal(stats.relation_types.exports ?? 0, 0);
    assert.equal(stats.tracked_code_files, 0);
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CodeIndexService.indexDirectory tracks cache status, skips unchanged files, and clears deleted files", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-code-index-graph-"));
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const graphService = new KnowledgeGraphService(repository);
  const service = new CodeIndexService(repository, memoryService, {
    features: {
      codeGraph: true
    }
  });
  const indexPath = join(tempDir, "src", "index.ts");
  const utilPath = join(tempDir, "src", "util.ts");
  const keepPath = join(tempDir, "src", "keep.ts");

  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(
    indexPath,
    [
      "import { join } from \"node:path\";",
      "export class App {}",
      "export async function run(name: string): Promise<void> {}"
    ].join("\n"),
    "utf8"
  );
  writeFileSync(utilPath, ["export function oldUtil(): void {}", ""].join("\n"), "utf8");
  writeFileSync(keepPath, ["export function keepAlive(): void {}", ""].join("\n"), "utf8");

  try {
    await service.indexDirectory(tempDir, ["ts"], { graph: true });

    const firstMemory = repository.listMemories({
      project: basename(tempDir),
      type: "project_context",
      limit: 20
    }).find((memory) => memory.title === "Code Index: src/keep.ts");
    const firstStats = graphService.getStats();
    const cacheTable = repository.db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'graph_content_cache'"
      )
      .get();

    assert.ok(firstMemory);
    assert.ok(cacheTable);
    assert.equal(firstStats.tracked_code_files, 3);
    assert.equal((firstStats.entity_types.module ?? 0) >= 1, true);
    assert.equal((firstStats.relation_types.imports ?? 0) >= 1, true);
    assert.equal((firstStats.relation_types.declares ?? 0) >= 1, true);
    assert.equal((firstStats.relation_types.exports ?? 0) >= 1, true);
    assert.equal(
      repository.db
        .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM graph_content_cache")
        .get()?.total ?? 0,
      3
    );
    assert.deepEqual(service.getDirectoryStatus(tempDir, ["ts"]), {
      indexed_files: 3,
      pending_files: 0,
      new_files: 0,
      modified_files: 0,
      deleted_files: 0,
      unchanged_files: 3
    });

    await service.indexDirectory(tempDir, ["ts"], { graph: true });

    const unchangedMemory = repository.listMemories({
      project: basename(tempDir),
      type: "project_context",
      limit: 20
    }).find((memory) => memory.title === "Code Index: src/keep.ts");

    assert.equal(unchangedMemory?.updated_at, firstMemory.updated_at);

    const deletedMemoryId = repository
      .listMemories({
        project: basename(tempDir),
        type: "project_context",
        limit: 20
      })
      .find((memory) => memory.title === "Code Index: src/util.ts")?.id;

    writeFileSync(
      indexPath,
      [
        "import { join } from \"node:path\";",
        "export class App {}",
        "export async function run(name: string): Promise<string> {",
        "  return join(name, \"done\");",
        "}"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(tempDir, "src", "new.ts"),
      ["export const created = true;", ""].join("\n"),
      "utf8"
    );
    rmSync(utilPath, { force: true });

    assert.deepEqual(service.getDirectoryStatus(tempDir, ["ts"]), {
      indexed_files: 3,
      pending_files: 2,
      new_files: 1,
      modified_files: 1,
      deleted_files: 1,
      unchanged_files: 1
    });

    await service.indexDirectory(tempDir, ["ts"], { graph: true, incremental: true });

    const stats = graphService.getStats();

    assert.equal(stats.tracked_code_files, 3);
    assert.equal(graphService.query("module:src/util.ts").entity, null);
    assert.equal(
      deletedMemoryId === undefined ? null : repository.getMemory(deletedMemoryId),
      null
    );
    assert.equal(
      repository.db
        .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM graph_content_cache")
        .get()?.total ?? 0,
      3
    );
    assert.deepEqual(service.getDirectoryStatus(tempDir, ["ts"]), {
      indexed_files: 3,
      pending_files: 0,
      new_files: 0,
      modified_files: 0,
      deleted_files: 0,
      unchanged_files: 3
    });
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

test("ImageMemoryService generates a description when none is supplied", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-image-memory-auto-"));
  const imagePath = join(tempDir, "shot.png");
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const analyzer = new ImageAnalyzer({
    ocrEnabled: true,
    analysisEnabled: true,
    ocrExecutor: async () => ({
      text: "auto text",
      confidence: 1,
      language: "eng",
      regions: []
    }),
    analysisExecutor: async () => ({
      description: "auto description",
      tags: ["auto"],
      objects: [],
      colors: [],
      dimensions: { width: 1, height: 1 }
    })
  });
  const service = new ImageMemoryService(repository, memoryService, analyzer);

  writeFileSync(
    imagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxO8AAAAASUVORK5CYII=",
      "base64"
    )
  );

  try {
    const memoryId = await service.storeScreenshot(imagePath, "", "alpha");
    const memory = repository.getMemory(memoryId);

    assert.match(memory?.content ?? "", /auto text/);
    assert.match(memory?.content ?? "", /\[Image:/);
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

test("DocIndexService.indexMarkdown builds document graph sidecar when enabled", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-doc-index-graph-"));
  const filePath = join(tempDir, "guide.md");
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const graphService = new KnowledgeGraphService(repository);
  const service = new DocIndexService(repository, memoryService, {
    features: {
      codeGraph: true
    }
  });

  writeFileSync(
    filePath,
    [
      "## Setup",
      "",
      "Core Term: explained for the graph sidecar.",
      "",
      "### Nested",
      "",
      "See [[API Guide]] for more detail.",
      ""
    ].join("\n"),
    "utf8"
  );

  try {
    const count = await service.indexMarkdown(filePath, "docs", { graph: true });
    const stats = graphService.getStats();

    assert.equal(count, 1);
    assert.equal(stats.tracked_doc_files, 1);
    assert.equal((stats.entity_types.document ?? 0) >= 1, true);
    assert.equal((stats.entity_types.heading ?? 0) >= 1, true);
    assert.equal((stats.entity_types.term ?? 0) >= 1, true);
    assert.equal(stats.relation_types.contains ?? 0, 2);
    assert.equal(stats.relation_types.references ?? 0, 1);
    assert.equal(stats.relation_types.defines ?? 0, 1);
  } finally {
    restoreFetch();
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DocIndexService.indexDirectory tracks cache status and removes stale section memories", async () => {
  const restoreFetch = installEmbeddingMock();
  const tempDir = mkdtempSync(join(tmpdir(), "vega-doc-index-incremental-"));
  const repository = new Repository(":memory:");
  const memoryService = new MemoryService(repository, baseConfig);
  const service = new DocIndexService(repository, memoryService, {
    features: {
      codeGraph: true
    }
  });
  const guidePath = join(tempDir, "guide.md");
  const deletePath = join(tempDir, "delete.md");
  const keepPath = join(tempDir, "keep.md");

  writeFileSync(
    guidePath,
    ["## Setup", "", "Initial setup notes.", "", "## API", "", "Old API section."].join("\n"),
    "utf8"
  );
  writeFileSync(deletePath, ["## Delete", "", "This file will be removed."].join("\n"), "utf8");
  writeFileSync(keepPath, ["## Keep", "", "This file stays unchanged."].join("\n"), "utf8");

  try {
    await service.indexDirectory(tempDir, "docs", ["md"], { graph: true });

    const keepMemory = repository
      .listMemories({
        project: "docs",
        type: "project_context",
        limit: 20
      })
      .find((memory) => memory.title === "keep.md: Keep");
    const staleGuideMemoryId = repository
      .listMemories({
        project: "docs",
        type: "project_context",
        limit: 20
      })
      .find((memory) => memory.title === "guide.md: API")?.id;

    assert.ok(keepMemory);
    assert.equal(
      repository.db
        .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM graph_content_cache")
        .get()?.total ?? 0,
      3
    );
    assert.deepEqual(service.getDirectoryStatus(tempDir, ["md"]), {
      indexed_files: 3,
      pending_files: 0,
      new_files: 0,
      modified_files: 0,
      deleted_files: 0,
      unchanged_files: 3
    });

    writeFileSync(
      guidePath,
      ["## Setup", "", "Updated setup notes.", "", "## New", "", "Fresh section."].join("\n"),
      "utf8"
    );
    writeFileSync(join(tempDir, "new.md"), ["## Added", "", "Brand new file."].join("\n"), "utf8");
    rmSync(deletePath, { force: true });

    assert.deepEqual(service.getDirectoryStatus(tempDir, ["md"]), {
      indexed_files: 3,
      pending_files: 2,
      new_files: 1,
      modified_files: 1,
      deleted_files: 1,
      unchanged_files: 1
    });

    await service.indexDirectory(tempDir, "docs", ["md"], {
      graph: true,
      incremental: true
    });

    assert.equal(
      staleGuideMemoryId === undefined ? null : repository.getMemory(staleGuideMemoryId),
      null
    );
    assert.equal(
      repository
        .listMemories({
          project: "docs",
          type: "project_context",
          limit: 20
        })
        .some((memory) => memory.title === "delete.md: Delete"),
      false
    );
    assert.equal(
      repository
        .listMemories({
          project: "docs",
          type: "project_context",
          limit: 20
        })
        .find((memory) => memory.title === "keep.md: Keep")?.updated_at,
      keepMemory.updated_at
    );
    assert.deepEqual(service.getDirectoryStatus(tempDir, ["md"]), {
      indexed_files: 3,
      pending_files: 0,
      new_files: 0,
      modified_files: 0,
      deleted_files: 0,
      unchanged_files: 3
    });
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
    graphService: createGraphServiceStub({
      query: () => ({
        entity: {
          id: "entity-1",
          name: "Vega Memory",
          type: "project",
          metadata: {},
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
    }),
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
        relevant_wiki_pages: [],
        wiki_drafts_pending: 0,
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
          {
            handler: (
              args: { entity: string; depth: number; min_confidence?: number },
              extra: object
            ) => Promise<{ content: Array<{ text: string }> }>;
          }
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

test("memory_graph tool forwards min_confidence and serializes relation confidence", async () => {
  const repository = new Repository(":memory:");
  let queryArgs:
    | {
        entity: string;
        depth: number | undefined;
        minConfidence: number | undefined;
      }
    | undefined;
  const server = createMCPServer({
    repository,
    graphService: createGraphServiceStub({
      query: (entity, depth, minConfidence) => {
        queryArgs = { entity, depth, minConfidence };

        return {
          entity: {
            id: "entity-1",
            name: "Vega Memory",
            type: "project",
            metadata: {},
            created_at: "2026-04-05T00:00:00.000Z"
          },
          relations: [
            {
              id: "relation-1",
              source_entity_id: "entity-1",
              target_entity_id: "entity-2",
              relation_type: "uses",
              memory_id: "memory-1",
              confidence: 0.91,
              extraction_method: "EXTRACTED",
              created_at: "2026-04-05T00:00:00.000Z",
              source_entity_name: "Vega Memory",
              source_entity_type: "project",
              target_entity_name: "SQLite",
              target_entity_type: "tool"
            }
          ],
          memories: []
        };
      }
    }),
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
        relevant_wiki_pages: [],
        wiki_drafts_pending: 0,
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
          {
            handler: (
              args: { entity: string; depth: number; min_confidence?: number },
              extra: object
            ) => Promise<{ content: Array<{ text: string }> }>;
          }
        >;
      }
    )._registeredTools;
    const result = await registeredTools.memory_graph.handler(
      {
        entity: "Vega Memory",
        depth: 2,
        min_confidence: 0.75
      },
      {}
    );
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      relations: Array<{ confidence: number; extraction_method: string }>;
    };

    assert.deepEqual(queryArgs, {
      entity: "Vega Memory",
      depth: 2,
      minConfidence: 0.75
    });
    assert.equal(payload.relations[0]?.confidence, 0.91);
    assert.equal(payload.relations[0]?.extraction_method, "EXTRACTED");
  } finally {
    repository.close();
    await server.close();
  }
});

test("graph query tools forward arguments and serialize structured results", async () => {
  const repository = new Repository(":memory:");
  const received = {
    neighbors: undefined as
      | {
          entity: string;
          depth: number | undefined;
          minConfidence: number | undefined;
        }
      | undefined,
    path: undefined as
      | {
          from: string;
          to: string;
          maxDepth: number | undefined;
        }
      | undefined,
    stats: undefined as string | undefined,
    subgraph: undefined as
      | {
          entities: string[];
          depth: number | undefined;
        }
      | undefined
  };
  const server = createMCPServer({
    repository,
    graphService: createGraphServiceStub({
      getNeighbors: (entity, depth, minConfidence) => {
        received.neighbors = { entity, depth, minConfidence };

        return {
          entity: {
            id: "entity-1",
            name: entity,
            type: "project",
            metadata: {},
            created_at: "2026-04-05T00:00:00.000Z"
          },
          neighbors: [
            {
              id: "entity-2",
              name: "SQLite",
              type: "tool",
              metadata: {},
              created_at: "2026-04-05T00:00:00.000Z"
            }
          ],
          relations: [],
          memories: []
        };
      },
      shortestPath: (from, to, maxDepth) => {
        received.path = { from, to, maxDepth };

        return {
          from: {
            id: "entity-1",
            name: from,
            type: "project",
            metadata: {},
            created_at: "2026-04-05T00:00:00.000Z"
          },
          to: {
            id: "entity-3",
            name: to,
            type: "tool",
            metadata: {},
            created_at: "2026-04-05T00:00:00.000Z"
          },
          entities: [
            {
              id: "entity-1",
              name: from,
              type: "project",
              metadata: {},
              created_at: "2026-04-05T00:00:00.000Z"
            },
            {
              id: "entity-2",
              name: "SQLite",
              type: "tool",
              metadata: {},
              created_at: "2026-04-05T00:00:00.000Z"
            },
            {
              id: "entity-3",
              name: to,
              type: "tool",
              metadata: {},
              created_at: "2026-04-05T00:00:00.000Z"
            }
          ],
          relations: [],
          memories: [],
          found: true
        };
      },
      graphStats: (project) => {
        received.stats = project;

        return {
          project,
          total_entities: 3,
          total_relations: 2,
          entity_types: { project: 1, tool: 2 },
          relation_types: { uses: 2 },
          average_confidence: 0.75,
          tracked_code_files: 0,
          tracked_doc_files: 0
        };
      },
      subgraph: (entities, depth) => {
        received.subgraph = { entities, depth };

        return {
          seed_entities: [
            {
              id: "entity-1",
              name: entities[0] ?? "unknown",
              type: "project",
              metadata: {},
              created_at: "2026-04-05T00:00:00.000Z"
            }
          ],
          missing_entities: ["Missing Node"],
          entities: [
            {
              id: "entity-1",
              name: entities[0] ?? "unknown",
              type: "project",
              metadata: {},
              created_at: "2026-04-05T00:00:00.000Z"
            }
          ],
          relations: [],
          memories: []
        };
      }
    }),
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
        relevant_wiki_pages: [],
        wiki_drafts_pending: 0,
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
          {
            handler: (args: Record<string, unknown>, extra: object) => Promise<{ content: Array<{ text: string }> }>;
          }
        >;
      }
    )._registeredTools;
    const neighborsResult = await registeredTools.graph_neighbors.handler(
      {
        entity: "Vega Memory",
        depth: 2,
        min_confidence: 0.5
      },
      {}
    );
    const pathResult = await registeredTools.graph_path.handler(
      {
        from_entity: "Vega Memory",
        to_entity: "Ollama",
        max_depth: 4
      },
      {}
    );
    const statsResult = await registeredTools.graph_stats.handler(
      {
        project: "vega"
      },
      {}
    );
    const subgraphResult = await registeredTools.graph_subgraph.handler(
      {
        entities: ["Vega Memory", "Missing Node"],
        depth: 1
      },
      {}
    );
    const neighborsPayload = JSON.parse(neighborsResult.content[0]?.text ?? "{}") as {
      neighbors: Array<{ name: string }>;
    };
    const pathPayload = JSON.parse(pathResult.content[0]?.text ?? "{}") as {
      found: boolean;
      entities: Array<{ name: string }>;
    };
    const statsPayload = JSON.parse(statsResult.content[0]?.text ?? "{}") as {
      project?: string;
      average_confidence: number;
    };
    const subgraphPayload = JSON.parse(subgraphResult.content[0]?.text ?? "{}") as {
      missing_entities: string[];
    };

    assert.deepEqual(received.neighbors, {
      entity: "Vega Memory",
      depth: 2,
      minConfidence: 0.5
    });
    assert.deepEqual(received.path, {
      from: "Vega Memory",
      to: "Ollama",
      maxDepth: 4
    });
    assert.equal(received.stats, "vega");
    assert.deepEqual(received.subgraph, {
      entities: ["Vega Memory", "Missing Node"],
      depth: 1
    });
    assert.equal(neighborsPayload.neighbors[0]?.name, "SQLite");
    assert.equal(pathPayload.found, true);
    assert.deepEqual(
      pathPayload.entities.map((entity) => entity.name),
      ["Vega Memory", "SQLite", "Ollama"]
    );
    assert.equal(statsPayload.project, "vega");
    assert.equal(statsPayload.average_confidence, 0.75);
    assert.deepEqual(subgraphPayload.missing_entities, ["Missing Node"]);
  } finally {
    repository.close();
    await server.close();
  }
});
