import { Command, InvalidArgumentError } from "commander";

import type { Repository } from "../../db/repository.js";

const parseLimit = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("limit must be a positive integer");
  }

  return parsed;
};

const parseSince = (value: string): string => {
  if (Number.isNaN(Date.parse(value))) {
    throw new InvalidArgumentError("since must be a valid date string");
  }

  return new Date(value).toISOString();
};

export function registerAuditCommand(program: Command, repository: Repository): void {
  program
    .command("audit")
    .description("Show audit log entries")
    .option("--actor <actor>", "actor name")
    .option("--action <action>", "action name")
    .option("--since <date>", "filter by timestamp", parseSince)
    .option("--memory <id>", "filter by memory id")
    .option("--limit <limit>", "maximum row count", parseLimit, 20)
    .action(
      (options: {
        actor?: string;
        action?: string;
        since?: string;
        memory?: string;
        limit: number;
      }) => {
        const entries = repository
          .getAuditLog({
            actor: options.actor,
            action: options.action,
            since: options.since,
            memory_id: options.memory
          })
          .slice(-options.limit)
          .reverse();

        if (entries.length === 0) {
          console.log("No audit entries found.");
          return;
        }

        console.table(
          entries.map((entry) => ({
            id: entry.id,
            timestamp: entry.timestamp,
            actor: entry.actor,
            action: entry.action,
            memory_id: entry.memory_id ?? "",
            detail: entry.detail
          }))
        );
      }
    );
}
