import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { VegaConfig } from "../config.js";
import { TopicService } from "../core/topic-service.js";
import { Repository } from "../db/repository.js";
import { PageManager } from "../wiki/page-manager.js";

const projectRoot = process.cwd();
const cliPath = join(projectRoot, "dist", "cli", "index.js");
const cliModuleUrl = pathToFileURL(cliPath).href;
const childBaseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("VEGA_") && key !== "OLLAMA_BASE_URL" && key !== "OLLAMA_MODEL"
  )
);
const cliBootstrap = `process.argv.splice(1, 0, ${JSON.stringify(cliPath)}); await import(${JSON.stringify(cliModuleUrl)});`;
const topicConfig: VegaConfig = {
  dbPath: ":memory:",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "bge-m3",
  tokenBudget: 2000,
  similarityThreshold: 0.85,
  shardingEnabled: false,
  backupRetentionDays: 7,
  observerEnabled: false,
  dbEncryption: false,
  apiPort: 3271,
  apiKey: undefined,
  mode: "server",
  serverUrl: undefined,
  cacheDbPath: "./data/cache.db",
  telegramBotToken: undefined,
  telegramChatId: undefined
};

const runCli = (args: string[], env: NodeJS.ProcessEnv): string =>
  execFileSync(process.execPath, ["--input-type=module", "-e", cliBootstrap, "--", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...childBaseEnv,
      ...env
    }
  });

test("CLI help lists core commands", () => {
  const output = runCli(["--help"], {
    VEGA_DB_PATH: ":memory:",
    OLLAMA_BASE_URL: "http://localhost:99999"
  });

  assert.match(output, /\bstore\b/);
  assert.match(output, /\brecall\b/);
  assert.match(output, /\bsession-start\b/);
  assert.match(output, /\bhealth\b/);
  assert.match(output, /\barchive\b/);
});

test("CLI health --regression --json includes regression guard data", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-health-"));
  const dbPath = join(tempDir, "memory.db");

  try {
    const output = JSON.parse(
      runCli(["health", "--regression", "--json"], {
        VEGA_DB_PATH: dbPath,
        OLLAMA_BASE_URL: "http://localhost:99999"
      })
    ) as {
      status: string;
      regression_guard: {
        status: string;
        thresholds: {
          max_session_start_token: number;
        };
      };
    };

    assert.equal(typeof output.status, "string");
    assert.equal(typeof output.regression_guard.status, "string");
    assert.equal(output.regression_guard.thresholds.max_session_start_token, 2500);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI archive stats reports cold archive growth metrics", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-archive-stats-"));
  const dbPath = join(tempDir, "memory.db");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };

  try {
    runCli(
      [
        "store",
        "Cold archive stats should include this raw evidence.",
        "--type",
        "decision",
        "--project",
        "vega"
      ],
      env
    );

    const output = JSON.parse(runCli(["archive", "stats", "--json"], env)) as {
      total_count: number;
      with_embedding_count: number;
      without_embedding_count: number;
      total_size_mb: number;
    };

    assert.equal(output.total_count, 1);
    assert.equal(output.with_embedding_count, 0);
    assert.equal(output.without_embedding_count, 1);
    assert.equal(typeof output.total_size_mb, "number");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI store and list commands work together", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-store-"));
  const dbPath = join(tempDir, "memory.db");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };

  try {
    const storeOutput = runCli(
      [
        "store",
        "Remember SQLite for local search",
        "--type",
        "decision",
        "--project",
        "vega"
      ],
      env
    );
    const listOutput = runCli(["list", "--project", "vega"], env);

    assert.match(storeOutput, /\bcreated\b/);
    assert.match(listOutput, /Remember SQLite for local search/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI graph shows relation confidence and applies min-confidence filtering", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-graph-confidence-"));
  const dbPath = join(tempDir, "memory.db");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };

  try {
    runCli(
      [
        "store",
        "Vega Memory uses SQLite for local storage.",
        "--type",
        "project_context",
        "--project",
        "vega"
      ],
      env
    );

    const visibleOutput = runCli(["graph", "SQLite", "--min-confidence", "0.5"], env);
    const filteredOutput = JSON.parse(
      runCli(["graph", "SQLite", "--min-confidence", "0.7"], env)
    ) as {
      relations: unknown[];
      memories: unknown[];
    };

    assert.match(visibleOutput, /"confidence": 0\.6/);
    assert.match(visibleOutput, /"extraction_method": "AMBIGUOUS"/);
    assert.equal(filteredOutput.relations.length, 0);
    assert.equal(filteredOutput.memories.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI graph neighbors, path, and subgraph expose the new graph query primitives", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-graph-primitives-"));
  const dbPath = join(tempDir, "memory.db");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };

  try {
    runCli(
      [
        "store",
        "Vega Memory uses SQLite for local storage.",
        "--type",
        "project_context",
        "--project",
        "vega"
      ],
      env
    );
    runCli(
      [
        "store",
        "SQLite relates to Ollama embeddings.",
        "--type",
        "project_context",
        "--project",
        "vega"
      ],
      env
    );

    const neighbors = JSON.parse(
      runCli(["graph", "neighbors", "SQLite", "--min-confidence", "0.5"], env)
    ) as {
      entity: { name: string };
      neighbors: Array<{ name: string }>;
    };
    const path = JSON.parse(
      runCli(["graph", "path", "Vega Memory", "Ollama", "--max-depth", "2"], env)
    ) as {
      found: boolean;
      entities: Array<{ name: string }>;
    };
    const subgraph = JSON.parse(
      runCli(["graph", "subgraph", "SQLite", "Missing Node", "--depth", "1"], env)
    ) as {
      seed_entities: Array<{ name: string }>;
      missing_entities: string[];
      entities: Array<{ name: string }>;
    };
    const neighborNames = new Set(
      neighbors.neighbors.map((entity) => entity.name.toLowerCase())
    );
    const subgraphEntityNames = new Set(
      subgraph.entities.map((entity) => entity.name.toLowerCase())
    );

    assert.equal(neighbors.entity.name.toLowerCase(), "sqlite");
    assert.equal(neighborNames.has("vega memory"), true);
    assert.equal(neighborNames.has("ollama"), true);
    assert.equal(path.found, true);
    assert.deepEqual(
      path.entities.map((entity) => entity.name.toLowerCase()),
      ["vega memory", "sqlite", "ollama"]
    );
    assert.deepEqual(
      subgraph.seed_entities.map((entity) => entity.name.toLowerCase()),
      ["sqlite"]
    );
    assert.deepEqual(subgraph.missing_entities, ["Missing Node"]);
    assert.equal(subgraphEntityNames.has("sqlite"), true);
    assert.equal(subgraphEntityNames.has("vega memory"), true);
    assert.equal(subgraphEntityNames.has("ollama"), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI graph stats accepts project scoping and reports average confidence", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-graph-project-stats-"));
  const dbPath = join(tempDir, "memory.db");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };

  try {
    runCli(
      [
        "store",
        "Vega Memory uses SQLite for local storage.",
        "--type",
        "project_context",
        "--project",
        "vega"
      ],
      env
    );
    runCli(
      [
        "store",
        "Atlas uses Redis for caching.",
        "--type",
        "project_context",
        "--project",
        "atlas"
      ],
      env
    );

    const stats = JSON.parse(runCli(["graph", "stats", "--project", "vega"], env)) as {
      project?: string;
      total_relations: number;
      average_confidence: number | null;
    };

    assert.equal(stats.project, "vega");
    assert.equal(stats.total_relations > 0, true);
    assert.equal(stats.average_confidence, 0.6);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI index --graph and graph stats expose structural graph counts", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-graph-stats-"));
  const dbPath = join(tempDir, "memory.db");
  const sourceDir = join(tempDir, "repo");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999",
    VEGA_FEATURE_CODE_GRAPH: "true"
  };

  mkdirSync(join(sourceDir, "src"), { recursive: true });
  writeFileSync(
    join(sourceDir, "src", "index.ts"),
    [
      "import { join } from \"node:path\";",
      "export class App {}",
      "export function run(): void {}"
    ].join("\n"),
    "utf8"
  );

  try {
    const indexOutput = runCli(["index", sourceDir, "--graph"], env);
    const stats = JSON.parse(runCli(["graph", "stats"], env)) as {
      tracked_code_files: number;
      relation_types: Record<string, number>;
    };

    assert.match(indexOutput, /indexed 1 files/);
    assert.equal(stats.tracked_code_files, 1);
    assert.equal((stats.relation_types.imports ?? 0) > 0, true);
    assert.equal((stats.relation_types.declares ?? 0) > 0, true);
    assert.equal((stats.relation_types.exports ?? 0) > 0, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI graph report prints markdown and saves the report file", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-graph-report-"));
  const dbPath = join(tempDir, "memory.db");
  const sourceDir = join(tempDir, "repo");
  const savedReportPath = join(projectRoot, "data", "repo-graph-report.md");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };

  mkdirSync(join(sourceDir, "src"), { recursive: true });
  writeFileSync(
    join(sourceDir, "src", "index.js"),
    [
      "import { helper } from \"./util.js\";",
      "export function run() {",
      "  return helper();",
      "}"
    ].join("\n"),
    "utf8"
  );
  writeFileSync(join(sourceDir, "src", "util.js"), "export function helper() { return 1; }\n", "utf8");

  try {
    runCli(["index", sourceDir, "--graph", "--ext", "js"], env);

    const report = runCli(["graph", "report", "repo", "--save"], env);

    assert.match(report, /# Graph Report: repo/);
    assert.match(report, /## Module Dependencies/);
    assert.match(report, /`src\/index\.js` -> `src\/util\.js`/);
    assert.equal(existsSync(savedReportPath), true);
    assert.equal(readFileSync(savedReportPath, "utf8").trim(), report.trim());
  } finally {
    rmSync(savedReportPath, { force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI index --graph builds the sidecar graph and graph stats report it", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-graph-"));
  const dbPath = join(tempDir, "memory.db");
  const sourceDir = join(tempDir, "repo");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };

  mkdirSync(join(sourceDir, "src"), { recursive: true });
  writeFileSync(
    join(sourceDir, "src", "index.ts"),
    [
      "import { join } from \"node:path\";",
      "export class App {}",
      "export function run(): void {}"
    ].join("\n"),
    "utf8"
  );

  try {
    runCli(["index", sourceDir, "--graph", "--ext", "ts"], env);

    const stats = JSON.parse(runCli(["graph", "stats"], env)) as {
      tracked_code_files: number;
      entity_types: Record<string, number>;
      relation_types: Record<string, number>;
    };

    assert.equal(stats.tracked_code_files, 1);
    assert.equal((stats.entity_types.module ?? 0) >= 1, true);
    assert.equal((stats.relation_types.imports ?? 0) >= 1, true);
    assert.equal((stats.relation_types.declares ?? 0) >= 1, true);
    assert.equal((stats.relation_types.exports ?? 0) >= 1, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI index --status and --incremental report cache-backed refresh state", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-index-status-"));
  const dbPath = join(tempDir, "memory.db");
  const sourceDir = join(tempDir, "repo");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999",
    VEGA_FEATURE_CODE_GRAPH: "true"
  };

  mkdirSync(join(sourceDir, "src"), { recursive: true });
  writeFileSync(join(sourceDir, "src", "index.ts"), "export function run(): void {}\n", "utf8");
  writeFileSync(join(sourceDir, "src", "keep.ts"), "export function keep(): void {}\n", "utf8");
  writeFileSync(join(sourceDir, "src", "remove.ts"), "export function remove(): void {}\n", "utf8");

  try {
    runCli(["index", sourceDir, "--graph"], env);

    const initialStatus = JSON.parse(runCli(["index", sourceDir, "--status"], env)) as {
      indexed_files: number;
      pending_files: number;
      new_files: number;
      modified_files: number;
      deleted_files: number;
      unchanged_files: number;
    };

    assert.deepEqual(initialStatus, {
      indexed_files: 3,
      pending_files: 0,
      new_files: 0,
      modified_files: 0,
      deleted_files: 0,
      unchanged_files: 3
    });

    writeFileSync(
      join(sourceDir, "src", "index.ts"),
      ["export function run(): string {", "  return \"done\";", "}"].join("\n"),
      "utf8"
    );
    writeFileSync(join(sourceDir, "src", "new.ts"), "export const created = true;\n", "utf8");
    rmSync(join(sourceDir, "src", "remove.ts"), { force: true });

    const pendingStatus = JSON.parse(runCli(["index", sourceDir, "--status"], env)) as {
      indexed_files: number;
      pending_files: number;
      new_files: number;
      modified_files: number;
      deleted_files: number;
      unchanged_files: number;
    };

    assert.deepEqual(pendingStatus, {
      indexed_files: 3,
      pending_files: 2,
      new_files: 1,
      modified_files: 1,
      deleted_files: 1,
      unchanged_files: 1
    });

    const incrementalOutput = runCli(["index", sourceDir, "--graph", "--incremental"], env);
    const finalStatus = JSON.parse(runCli(["index", sourceDir, "--status"], env)) as {
      indexed_files: number;
      pending_files: number;
      new_files: number;
      modified_files: number;
      deleted_files: number;
      unchanged_files: number;
    };

    assert.match(incrementalOutput, /indexed 2 files/);
    assert.deepEqual(finalStatus, {
      indexed_files: 3,
      pending_files: 0,
      new_files: 0,
      modified_files: 0,
      deleted_files: 0,
      unchanged_files: 3
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI topic override and history expose versioned taxonomy changes", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-topic-"));
  const dbPath = join(tempDir, "memory.db");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };
  const repository = new Repository(dbPath);
  const topicService = new TopicService(repository, topicConfig);

  try {
    repository.createMemory({
      id: "topic-memory",
      tenant_id: null,
      type: "decision",
      project: "vega",
      title: "Topic memory",
      content: "Seed taxonomy history for CLI coverage.",
      summary: null,
      embedding: null,
      importance: 0.5,
      source: "explicit",
      tags: ["taxonomy"],
      created_at: "2026-04-09T00:00:00.000Z",
      updated_at: "2026-04-09T00:00:00.000Z",
      accessed_at: "2026-04-09T00:00:00.000Z",
      status: "active",
      verified: "verified",
      scope: "project",
      accessed_projects: ["vega"]
    });
    await topicService.assignTopic("topic-memory", "database", "auto");
    repository.close();

    const overrideOutput = JSON.parse(
      runCli(
        [
          "topic",
          "override",
          "--project",
          "vega",
          "--topic-key",
          "database",
          "--label",
          "Database Core",
          "--description",
          "CLI override",
          "--json"
        ],
        env
      )
    ) as {
      topic: {
        version: number;
        label: string;
      };
      reassigned_memory_count: number;
    };
    const historyOutput = JSON.parse(
      runCli(
        [
          "topic",
          "history",
          "--project",
          "vega",
          "--topic-key",
          "database",
          "--json"
        ],
        env
      )
    ) as Array<{ version: number; state: string; label: string }>;
    const reopened = new Repository(dbPath);
    const auditEntries = reopened.getAuditLog({ action: "topic_override" });

    assert.equal(overrideOutput.topic.version, 2);
    assert.equal(overrideOutput.topic.label, "Database Core");
    assert.equal(overrideOutput.reassigned_memory_count, 1);
    assert.deepEqual(
      historyOutput.map((topic) => ({
        version: topic.version,
        state: topic.state,
        label: topic.label
      })),
      [
        { version: 2, state: "active", label: "Database Core" },
        { version: 1, state: "superseded", label: "Database" }
      ]
    );
    assert.equal(auditEntries.length, 1);
    assert.equal(auditEntries[0]?.actor, "cli");
    reopened.close();
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI topic tunnel shows cross-project topic reuse as JSON", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-topic-tunnel-"));
  const dbPath = join(tempDir, "memory.db");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };
  const repository = new Repository(dbPath);
  const topicService = new TopicService(repository, topicConfig);

  try {
    repository.createMemory({
      id: "vega-decision",
      tenant_id: null,
      type: "decision",
      project: "vega",
      title: "Use SQLite",
      content: "Primary database choice for vega.",
      summary: null,
      embedding: null,
      importance: 0.5,
      source: "explicit",
      tags: ["database"],
      created_at: "2026-04-09T00:00:00.000Z",
      updated_at: "2026-04-09T00:00:00.000Z",
      accessed_at: "2026-04-09T00:00:00.000Z",
      status: "active",
      verified: "verified",
      scope: "project",
      accessed_projects: ["vega"]
    });
    repository.createMemory({
      id: "atlas-pitfall",
      tenant_id: null,
      type: "pitfall",
      project: "atlas",
      title: "WAL checkpoint",
      content: "Checkpoint before copying backups.",
      summary: null,
      embedding: null,
      importance: 0.5,
      source: "explicit",
      tags: ["database"],
      created_at: "2026-04-09T00:00:00.000Z",
      updated_at: "2026-04-09T00:00:00.000Z",
      accessed_at: "2026-04-09T00:00:00.000Z",
      status: "active",
      verified: "verified",
      scope: "project",
      accessed_projects: ["atlas"]
    });
    repository.createMemory({
      id: "atlas-decision",
      tenant_id: null,
      type: "decision",
      project: "atlas",
      title: "Use SQLite",
      content: "Primary database choice for atlas.",
      summary: null,
      embedding: null,
      importance: 0.5,
      source: "explicit",
      tags: ["database"],
      created_at: "2026-04-09T00:00:00.000Z",
      updated_at: "2026-04-09T00:00:00.000Z",
      accessed_at: "2026-04-09T00:00:00.000Z",
      status: "active",
      verified: "verified",
      scope: "project",
      accessed_projects: ["atlas"]
    });
    await topicService.assignTopic("vega-decision", "database", "explicit");
    await topicService.assignTopic("atlas-pitfall", "database", "explicit");
    await topicService.assignTopic("atlas-decision", "database", "explicit");
    repository.close();

    const tunnelOutput = JSON.parse(
      runCli(["topic", "tunnel", "database", "--json"], env)
    ) as {
      topic_key: string;
      project_count: number;
      total_memory_count: number;
      projects: Array<{ project: string; memory_count: number }>;
      common_decisions: Array<{ title: string; projects: string[]; occurrences: number }>;
      common_pitfalls: Array<{ title: string; projects: string[]; occurrences: number }>;
    };

    assert.equal(tunnelOutput.topic_key, "database");
    assert.equal(tunnelOutput.project_count, 2);
    assert.equal(tunnelOutput.total_memory_count, 3);
    assert.deepEqual(
      tunnelOutput.projects.map((project) => ({
        project: project.project,
        memory_count: project.memory_count
      })),
      [
        { project: "atlas", memory_count: 2 },
        { project: "vega", memory_count: 1 }
      ]
    );
    assert.deepEqual(
      tunnelOutput.common_decisions.map((summary) => ({
        title: summary.title,
        projects: summary.projects,
        occurrences: summary.occurrences
      })),
      [
        {
          title: "Use SQLite",
          projects: ["atlas", "vega"],
          occurrences: 2
        }
      ]
    );
    assert.deepEqual(tunnelOutput.common_pitfalls, []);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI Phase 5 commands support JSON output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-phase5-json-"));
  const dbPath = join(tempDir, "memory.db");
  const env = {
    VEGA_DB_PATH: dbPath,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };
  const repository = new Repository(dbPath);

  try {
    repository.createMemory({
      id: "phase5-decision",
      type: "decision",
      project: "vega",
      title: "Use SQLite",
      content: "Use SQLite for local persistence.",
      summary: null,
      embedding: null,
      importance: 0.6,
      source: "explicit",
      tags: ["sqlite"],
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      accessed_at: "2026-04-01T00:00:00.000Z",
      status: "active",
      verified: "verified",
      scope: "project",
      accessed_projects: ["vega"]
    });
    repository.createMemory({
      id: "phase5-long",
      type: "project_context",
      project: "vega",
      title: "Long memory",
      content: "L".repeat(1500),
      summary: null,
      embedding: null,
      importance: 0.5,
      source: "auto",
      tags: ["long"],
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      accessed_at: "2026-04-01T00:00:00.000Z",
      status: "active",
      verified: "unverified",
      scope: "project",
      accessed_projects: ["vega"]
    });

    const docs = JSON.parse(
      runCli(["generate-docs", "--project", "vega", "--type", "readme", "--json"], env)
    ) as { readme: string };
    const quality = JSON.parse(runCli(["quality", "--json"], env)) as {
      total: number;
      avg_score: number;
      low_quality: unknown[];
      degraded: number;
    };
    const compression = JSON.parse(
      runCli(["compress", "--project", "vega", "--dry-run", "--json"], env)
    ) as {
      eligible: number;
      total_chars: number;
    };

    assert.match(docs.readme, /^# vega README/m);
    assert.equal(quality.total, 2);
    assert.equal(typeof quality.avg_score, "number");
    assert.equal(compression.eligible, 1);
    assert.equal(compression.total_chars, 1500);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI export and import support encrypted JSON", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-export-encrypted-"));
  const sourceDbPath = join(tempDir, "source.db");
  const targetDbPath = join(tempDir, "target.db");
  const exportPath = join(tempDir, "memories.enc.json");
  const encryptionKey =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

  try {
    runCli(
      [
        "store",
        "Persist encrypted export data",
        "--type",
        "decision",
        "--project",
        "vega"
      ],
      {
        VEGA_DB_PATH: sourceDbPath,
        VEGA_ENCRYPTION_KEY: encryptionKey,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );

    const exportOutput = runCli(
      ["export", "--format", "json", "--encrypt", "-o", exportPath],
      {
        VEGA_DB_PATH: sourceDbPath,
        VEGA_ENCRYPTION_KEY: encryptionKey,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );
    const importOutput = runCli(["import", "--decrypt", exportPath], {
      VEGA_DB_PATH: targetDbPath,
      VEGA_ENCRYPTION_KEY: encryptionKey,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });
    const listed = runCli(["list"], {
      VEGA_DB_PATH: targetDbPath,
      VEGA_ENCRYPTION_KEY: encryptionKey,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });
    const encryptedContent = readFileSync(exportPath);

    assert.match(exportOutput, /\bexported 1 memories\b/);
    assert.match(importOutput, /\bimported 1 memories\b/);
    assert.equal(
      encryptedContent.includes(Buffer.from("Persist encrypted export data", "utf8")),
      false
    );
    assert.match(listed, /Persist encrypted export data/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI export and import round-trip JSON", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-export-"));
  const sourceDbPath = join(tempDir, "source.db");
  const targetDbPath = join(tempDir, "target.db");
  const exportPath = join(tempDir, "memories.json");

  try {
    runCli(
      [
        "store",
        "Prefer concise output for CLI responses",
        "--type",
        "preference",
        "--project",
        "vega",
        "--source",
        "explicit"
      ],
      {
        VEGA_DB_PATH: sourceDbPath,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );

    const exportOutput = runCli(
      ["export", "--format", "json", "-o", exportPath],
      {
        VEGA_DB_PATH: sourceDbPath,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );
    const importOutput = runCli(["import", exportPath], {
      VEGA_DB_PATH: targetDbPath,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });
    const listed = runCli(["list"], {
      VEGA_DB_PATH: targetDbPath,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });

    assert.match(exportOutput, /\bexported 1 memories\b/);
    assert.match(importOutput, /\bimported 1 memories\b/);
    assert.match(readFileSync(exportPath, "utf8"), /Prefer concise output/);
    assert.match(listed, /Prefer concise output for CLI responses/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI wiki publish and export commands support JSON output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-wiki-publish-"));
  const dbPath = join(tempDir, "memory.db");
  const vaultDir = join(tempDir, "vault");
  const exportDir = join(tempDir, "export");
  const env = {
    VEGA_DB_PATH: dbPath,
    VEGA_OBSIDIAN_VAULT: vaultDir,
    OLLAMA_BASE_URL: "http://localhost:99999"
  };
  const repository = new Repository(dbPath);
  const pageManager = new PageManager(repository);

  try {
    const page = pageManager.createPage({
      title: "CLI Publish Topic",
      content: "Publish from the CLI.",
      summary: "CLI publish page.",
      page_type: "topic"
    });

    pageManager.updatePage(
      page.id,
      {
        status: "published",
        reviewed: true,
        published_at: "2026-04-07T00:00:00.000Z"
      },
      "Seed published page"
    );

    const publishResult = JSON.parse(
      runCli(
        ["wiki", "publish", "--slug", page.slug, "--target", "obsidian", "--json"],
        env
      )
    ) as {
      published_count: number;
      errors: string[];
    };
    const exportResult = JSON.parse(
      runCli(
        ["wiki", "export", "--format", "markdown", "--output", exportDir, "--json"],
        env
      )
    ) as {
      exported: number;
      outputDir: string;
    };

    assert.equal(publishResult.published_count, 1);
    assert.deepEqual(publishResult.errors, []);
    assert.equal(existsSync(join(vaultDir, "topics", "cli-publish-topic.md")), true);
    assert.equal(exportResult.exported, 1);
    assert.equal(exportResult.outputDir, exportDir);
    assert.equal(existsSync(join(exportDir, "topics", "cli-publish-topic.md")), true);
  } finally {
    repository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI JSON export/import preserves archived metadata", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-export-metadata-"));
  const sourceDbPath = join(tempDir, "source.db");
  const targetDbPath = join(tempDir, "target.db");
  const exportPath = join(tempDir, "memories.json");
  const sourceRepository = new Repository(sourceDbPath);

  try {
    sourceRepository.createMemory({
      id: "archived-global-memory",
      type: "decision",
      project: "project-a",
      title: "Archived Global Decision",
      content: "Preserve archived metadata during export and import.",
      summary: null,
      embedding: null,
      importance: 0.6,
      source: "explicit",
      tags: ["archive", "global"],
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
      accessed_at: "2026-04-03T00:00:00.000Z",
      status: "archived",
      verified: "verified",
      scope: "global",
      accessed_projects: ["project-a", "project-b"]
    });
    sourceRepository.updateMemory(
      "archived-global-memory",
      {
        access_count: 7,
        accessed_at: "2026-04-03T00:00:00.000Z",
        updated_at: "2026-04-02T00:00:00.000Z"
      },
      {
        skipVersion: true
      }
    );

    const exportOutput = runCli(
      ["export", "--format", "json", "--archived", "-o", exportPath],
      {
        VEGA_DB_PATH: sourceDbPath,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );
    const importOutput = runCli(["import", exportPath], {
      VEGA_DB_PATH: targetDbPath,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });
    const targetRepository = new Repository(targetDbPath);

    try {
      const imported = targetRepository.getMemory("archived-global-memory");

      assert.match(exportOutput, /\bexported 1 memories\b/);
      assert.match(importOutput, /\bimported 1 memories\b/);
      assert.ok(imported);
      assert.equal(imported.status, "archived");
      assert.equal(imported.scope, "global");
      assert.equal(imported.verified, "verified");
      assert.equal(imported.source, "explicit");
      assert.equal(imported.access_count, 7);
      assert.deepEqual(imported.accessed_projects, ["project-a", "project-b"]);
      assert.match(readFileSync(exportPath, "utf8"), /"format": "vega-memory\/v1"/);
    } finally {
      targetRepository.close();
    }
  } finally {
    sourceRepository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI JSON export/import preserves source_context", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vega-cli-export-source-context-"));
  const sourceDbPath = join(tempDir, "source.db");
  const targetDbPath = join(tempDir, "target.db");
  const exportPath = join(tempDir, "memories.json");
  const sourceRepository = new Repository(sourceDbPath);

  try {
    sourceRepository.createMemory({
      id: "memory-with-source-context",
      type: "insight",
      project: "test-project",
      title: "Source Context Memory",
      content: "This memory has source context from a specific device.",
      summary: null,
      embedding: null,
      importance: 0.5,
      source: "explicit",
      tags: [],
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      accessed_at: "2026-04-01T00:00:00.000Z",
      status: "active",
      verified: "verified",
      scope: "project",
      accessed_projects: ["test-project"],
      source_context: {
        actor: "user",
        channel: "mcp",
        device_id: "test-device-123",
        device_name: "Test MacBook",
        platform: "darwin",
        session_id: "session-abc"
      }
    });

    runCli(
      ["export", "--format", "json", "-o", exportPath],
      {
        VEGA_DB_PATH: sourceDbPath,
        OLLAMA_BASE_URL: "http://localhost:99999"
      }
    );

    const exportedJson = readFileSync(exportPath, "utf8");
    assert.match(exportedJson, /"device_id": "test-device-123"/);
    assert.match(exportedJson, /"device_name": "Test MacBook"/);

    runCli(["import", exportPath], {
      VEGA_DB_PATH: targetDbPath,
      OLLAMA_BASE_URL: "http://localhost:99999"
    });

    const targetRepository = new Repository(targetDbPath);

    try {
      const imported = targetRepository.getMemory("memory-with-source-context");

      assert.ok(imported);
      assert.ok(imported.source_context);
      assert.equal(imported.source_context.device_id, "test-device-123");
      assert.equal(imported.source_context.device_name, "Test MacBook");
      assert.equal(imported.source_context.platform, "darwin");
      assert.equal(imported.source_context.session_id, "session-abc");
    } finally {
      targetRepository.close();
    }
  } finally {
    sourceRepository.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
