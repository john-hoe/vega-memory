import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { MigrationTool } from "../../db/migration.js";

const parseEngine = (value: string): "sqlite" | "postgres" => {
  if (value === "sqlite" || value === "postgres") {
    return value;
  }

  throw new InvalidArgumentError("supported engines are sqlite and postgres");
};

export function registerMigrateCommand(program: Command): void {
  program
    .command("migrate-db")
    .description("Generate PostgreSQL DDL from a SQLite database")
    .requiredOption("--from <engine>", "source database engine", parseEngine)
    .requiredOption("--to <engine>", "target database engine", parseEngine)
    .requiredOption("--source <path>", "source SQLite database path")
    .requiredOption("--output <file>", "output file for generated PostgreSQL SQL")
    .action((options: {
      from: "sqlite" | "postgres";
      to: "sqlite" | "postgres";
      source: string;
      output: string;
    }) => {
      if (options.from !== "sqlite" || options.to !== "postgres") {
        throw new Error("Only sqlite-to-postgres migration is supported");
      }

      const tool = new MigrationTool();
      const outputPath = resolve(options.output);
      const migrationData = tool.exportSqlite(resolve(options.source));
      const statements = tool.generatePgSql(migrationData);

      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${statements.join("\n\n")}\n`, "utf8");
      console.log(`wrote ${statements.length} statements to ${outputPath}`);
    });
}
