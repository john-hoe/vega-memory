#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Command } from "commander";

import { loadConfig } from "../config.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerImportExportCommands } from "./commands/import-export.js";
import { registerListCommand } from "./commands/list.js";
import { registerMaintenanceCommands } from "./commands/maintenance.js";
import { registerRecallCommand } from "./commands/recall.js";
import { registerSessionCommands } from "./commands/session.js";
import { registerStoreCommand } from "./commands/store.js";
import { CompactService } from "../core/compact.js";
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

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDataDirectory(config.dbPath);

  const repository = new Repository(config.dbPath);
  const searchEngine = new SearchEngine(repository, config);
  const memoryService = new MemoryService(repository, config);
  const recallService = new RecallService(repository, searchEngine, config);
  const sessionService = new SessionService(
    repository,
    memoryService,
    recallService,
    config
  );
  const compactService = new CompactService(repository, config);

  const program = new Command()
    .name("vega")
    .description("Vega Memory System CLI")
    .showHelpAfterError();

  registerStoreCommand(program, memoryService);
  registerRecallCommand(program, recallService);
  registerListCommand(program, recallService);
  registerSessionCommands(program, sessionService);
  registerHealthCommand(program, repository, config);
  registerMaintenanceCommands(program, repository, compactService, config);
  registerImportExportCommands(program, repository, memoryService);
  registerAuditCommand(program, repository);

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
