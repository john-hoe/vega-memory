import { Command, CommanderError, InvalidArgumentError } from "commander";

import {
  loadConfig,
  requireDatabaseEncryptionKey
} from "../../config.js";
import { createLogger } from "../../core/logging/index.js";
import { createAdapter } from "../../db/adapter-factory.js";
import { applyRawInboxMigration } from "../../ingestion/raw-inbox.js";
import { replayFromRawInbox, type ReplayFilter } from "../../ingestion/replay.js";
import { resolveConfiguredEncryptionKey } from "../../security/keychain.js";

interface ReplayCommandOptions {
  eventId?: string;
  sessionId?: string;
  project?: string;
  surface?: string;
  from?: string[];
  to?: string;
  limit?: number;
  classifierVersion?: string;
  scoreVersion?: string;
  db?: string;
}

interface FromResolution {
  source: string;
  hostTimestampFrom?: string;
}

const logger = createLogger({
  name: "cli-replay",
  output: (record) => {
    console.error(JSON.stringify(record));
  }
});

const collectValues = (value: string, previous: string[]): string[] => [...previous, value];

const parsePositiveInt = (value: string): number => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("limit must be a positive integer");
  }

  return parsed;
};

const isIsoDateTime = (value: string): boolean =>
  Number.isNaN(Date.parse(value)) === false && value.includes("T");

const resolveFromValues = (values: string[] | undefined): FromResolution => {
  const resolved: FromResolution = {
    source: "raw_inbox"
  };

  for (const value of values ?? []) {
    if (value === "raw_inbox") {
      continue;
    }

    if (isIsoDateTime(value)) {
      if (resolved.hostTimestampFrom !== undefined) {
        throw new InvalidArgumentError("multiple timestamp lower bounds were provided");
      }

      resolved.hostTimestampFrom = value;
      continue;
    }

    if (resolved.source !== "raw_inbox") {
      throw new InvalidArgumentError("multiple replay sources were provided");
    }

    resolved.source = value;
  }

  if (resolved.source !== "raw_inbox") {
    throw new InvalidArgumentError("only raw_inbox replay is currently supported");
  }

  return resolved;
};

const buildFilter = (
  options: ReplayCommandOptions,
  hostTimestampFrom: string | undefined
): ReplayFilter => ({
  ...(options.eventId === undefined ? {} : { event_id: options.eventId }),
  ...(options.sessionId === undefined ? {} : { session_id: options.sessionId }),
  ...(options.project === undefined ? {} : { project: options.project }),
  ...(options.surface === undefined ? {} : { surface: options.surface }),
  ...(hostTimestampFrom === undefined ? {} : { host_timestamp_from: hostTimestampFrom }),
  ...(options.to === undefined ? {} : { host_timestamp_to: options.to }),
  ...(options.limit === undefined ? {} : { limit: options.limit })
});

export function createReplayCommand(): Command {
  return new Command("replay")
    .description("Replay raw inbox events as JSONL")
    .option(
      "--from <value>",
      "replay source selector (raw_inbox) or lower-bound ISO timestamp; may be passed twice",
      collectValues,
      []
    )
    .option("--event-id <uuid>", "filter by event id")
    .option("--session-id <id>", "filter by session id")
    .option("--project <name>", "filter by project")
    .option("--surface <name>", "filter by surface")
    .option("--to <iso>", "upper-bound host timestamp (inclusive)")
    .option("--limit <n>", "limit row count", parsePositiveInt)
    .option("--classifier-version <v>", "attach classifier version metadata")
    .option("--score-version <v>", "attach score version metadata")
    .option("--db <path>", "SQLite database path override")
    .action(async (options: ReplayCommandOptions) => {
      const { source, hostTimestampFrom } = resolveFromValues(options.from);
      const config = loadConfig();
      const encryptionKey = requireDatabaseEncryptionKey(
        config,
        config.dbEncryption ? await resolveConfiguredEncryptionKey(config) : undefined
      );
      const adapter = createAdapter({
        ...config,
        dbPath: options.db ?? config.dbPath,
        encryptionKey
      });

      try {
        if (source !== "raw_inbox") {
          throw new InvalidArgumentError("only raw_inbox replay is currently supported");
        }

        applyRawInboxMigration(adapter);

        const filter = buildFilter(options, hostTimestampFrom);
        const replayed = replayFromRawInbox(adapter, filter, {
          classifier_version: options.classifierVersion,
          score_version: options.scoreVersion
        });

        logger.info("Replay completed", {
          source,
          scanned: replayed.length,
          replayed: replayed.length
        });

        for (const event of replayed) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
      } catch (error) {
        if (error instanceof InvalidArgumentError) {
          throw error;
        }

        throw new CommanderError(
          2,
          "vega.replay.db_error",
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        adapter.close();
      }
    });
}
