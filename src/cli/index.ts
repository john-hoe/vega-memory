#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Command } from "commander";

import { loadConfig } from "../config.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerBenchmarkCommand } from "./commands/benchmark.js";
import { registerDiagnoseCommand } from "./commands/diagnose.js";
import { registerEncryptionCommand } from "./commands/encryption.js";
import { registerGitImportCommand } from "./commands/git-import.js";
import { registerGraphCommand } from "./commands/graph.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerCodeIndexCommand } from "./commands/index-code.js";
import { registerDocIndexCommand } from "./commands/index-docs.js";
import { registerImportExportCommands } from "./commands/import-export.js";
import { registerListCommand } from "./commands/list.js";
import { registerMaintenanceCommands } from "./commands/maintenance.js";
import { registerMigrateCommand } from "./commands/migrate.js";
import { registerRecallCommand } from "./commands/recall.js";
import { registerScreenshotCommand } from "./commands/screenshot.js";
import { registerSessionCommands } from "./commands/session.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerStoreCommand } from "./commands/store.js";
import { CompactService } from "../core/compact.js";
import { CodeIndexService } from "../core/code-index.js";
import { DocIndexService } from "../core/doc-index.js";
import { GitHistoryService } from "../core/git-history.js";
import { ImageMemoryService } from "../core/image-memory.js";
import { KnowledgeGraphService } from "../core/knowledge-graph.js";
import { MemoryService } from "../core/memory.js";
import { RecallService } from "../core/recall.js";
import { SessionService } from "../core/session.js";
import { Repository } from "../db/repository.js";
import { SearchEngine } from "../search/engine.js";

const ensureDataDirectory = (dbPath: string): void => {
  if (dbPath === ":memory:") {
    return;
  }

  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
};

const createProgram = (): Command =>
  new Command().name("vega").description("Vega Memory System CLI").showHelpAfterError();

const isBootstrapInvocation = (argv: string[]): boolean => {
  const [firstArg, secondArg] = argv;

  return (
    firstArg === "setup" ||
    firstArg === "init-encryption" ||
    (firstArg === "help" &&
      (secondArg === "setup" || secondArg === "init-encryption"))
  );
};

async function main(): Promise<void> {
  const program = createProgram();
  registerSetupCommand(program);
  registerEncryptionCommand(program);

  if (isBootstrapInvocation(process.argv.slice(2))) {
    await program.parseAsync(process.argv);
    return;
  }

  const config = loadConfig();
  ensureDataDirectory(config.dbPath);

  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const knowledgeGraphService = new KnowledgeGraphService(repository);
  const memoryService = new MemoryService(repository, config, knowledgeGraphService);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(
    repository,
    memoryService,
    recallService,
    config
  );
  const compactService = new CompactService(repository, config);
  const codeIndexService = new CodeIndexService(repository);
  const gitHistoryService = new GitHistoryService(repository, memoryService);
  const imageMemoryService = new ImageMemoryService(repository, memoryService);
  const docIndexService = new DocIndexService(repository, memoryService);

  registerStoreCommand(program, memoryService);
  registerRecallCommand(program, recallService);
  registerListCommand(program, recallService);
  registerGraphCommand(program, knowledgeGraphService);
  registerCodeIndexCommand(program, codeIndexService);
  registerGitImportCommand(program, gitHistoryService);
  registerScreenshotCommand(program, imageMemoryService);
  registerDocIndexCommand(program, docIndexService);
  registerSessionCommands(program, sessionService);
  registerHealthCommand(program, repository, config);
  registerDiagnoseCommand(program, repository, config);
  registerMaintenanceCommands(program, repository, compactService, config);
  registerImportExportCommands(program, repository, memoryService, config);
  registerMigrateCommand(program, memoryService);
  registerAuditCommand(program, repository);
  registerBenchmarkCommand(program, repository, memoryService, recallService, config);

  try {
    await program.parseAsync(process.argv);
  } finally {
    repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
