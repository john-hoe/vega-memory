import { Command, InvalidArgumentError } from "commander";

import { GitHistoryService } from "../../core/git-history.js";

const parseLimit = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("limit must be a positive integer");
  }

  return parsed;
};

export function registerGitImportCommand(
  program: Command,
  gitHistoryService: GitHistoryService
): void {
  program
    .command("git-import")
    .description("Import git history into memory")
    .argument("<repo-path>", "git repository path")
    .option("--since <date>", "git --since value")
    .option("--limit <limit>", "maximum commit count", parseLimit, 50)
    .action(async (repoPath: string, options: { since?: string; limit: number }) => {
      const imported = await gitHistoryService.extractFromGitLog(
        repoPath,
        options.since,
        options.limit
      );

      console.log(`imported ${imported} commits`);
    });
}
